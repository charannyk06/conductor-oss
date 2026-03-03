/**
 * Conductor MCP Server
 *
 * Exposes Conductor as a Model Context Protocol (MCP) server so that
 * AI clients (Cursor, Claude Desktop, Windsurf, etc.) can dispatch tasks
 * and inspect sessions over the standard stdio transport.
 *
 * Tools:
 *   conductor_dispatch        — Create and dispatch a task
 *   conductor_list_sessions   — List active sessions
 *   conductor_session_status  — Get status of a specific session
 *   conductor_list_projects   — List configured projects
 *   conductor_kill_session    — Kill a running session
 *
 * Resources:
 *   conductor://projects      — All configured projects
 *   conductor://sessions      — All active sessions
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { OrchestratorConfig, SessionManager, Session, ProjectConfig } from "@conductor-oss/core";

// ---------------------------------------------------------------------------
// Service initialisation (deferred so the module can be imported cheaply)
// ---------------------------------------------------------------------------

let _config: OrchestratorConfig | null = null;
let _sessionManager: SessionManager | null = null;

async function getServices(): Promise<{
  config: OrchestratorConfig;
  sessionManager: SessionManager;
}> {
  if (_config && _sessionManager) {
    return { config: _config, sessionManager: _sessionManager };
  }

  // Lazy-load core to avoid startup overhead when just importing the module
  const core = await import("@conductor-oss/core");

  if (typeof core.loadConfig !== "function") {
    throw new Error("@conductor-oss/core does not export loadConfig");
  }
  if (typeof core.createPluginRegistry !== "function") {
    throw new Error("@conductor-oss/core does not export createPluginRegistry");
  }
  if (typeof core.createSessionManager !== "function") {
    throw new Error("@conductor-oss/core does not export createSessionManager");
  }

  _config = (await core.loadConfig()) as OrchestratorConfig;

  // Lazily import all built-in agent/runtime/workspace plugins
  const registry = core.createPluginRegistry();
  await registry.loadBuiltins(_config);

  _sessionManager = core.createSessionManager({
    config: _config,
    registry,
  }) as SessionManager;

  return { config: _config, sessionManager: _sessionManager };
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function serializeSession(s: Session): Record<string, unknown> {
  return {
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    activity: s.activity,
    branch: s.branch,
    issueId: s.issueId,
    pr: s.pr,
    workspacePath: s.workspacePath,
    summary: s.agentInfo?.summary ?? s.metadata["summary"] ?? null,
    createdAt: s.createdAt.toISOString(),
    lastActivityAt: s.lastActivityAt.toISOString(),
  };
}

function serializeProject(id: string, p: ProjectConfig): Record<string, unknown> {
  return {
    id,
    name: p.name,
    repo: p.repo,
    path: p.path,
    defaultBranch: p.defaultBranch,
    agent: p.agent ?? null,
    runtime: p.runtime ?? null,
  };
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "conductor",
    version: "0.1.0",
  });

  // -------------------------------------------------------------------------
  // Tool: conductor_dispatch
  // -------------------------------------------------------------------------
  server.tool(
    "conductor_dispatch",
    "Create and dispatch a new agent task in Conductor",
    {
      task: z.string().describe("The task prompt or description for the agent"),
      project: z.string().optional().describe("Project ID from conductor config"),
      agent: z.string().optional().describe("Agent to use"),
      model: z.string().optional().describe("Model override for this session"),
      profile: z.string().optional().describe("Named agent profile"),
      branch: z.string().optional().describe("Target branch"),
      baseBranch: z.string().optional().describe("Optional base branch"),
      prompt: z.string().optional().describe("Prompt override"),
      priority: z.string().optional().describe("Priority hint (informational, not enforced)"),
    },
    async ({
      task,
      project,
      agent,
      model,
      profile,
      branch,
      baseBranch,
      prompt,
    }) => {
      try {
        const { config, sessionManager } = await getServices();

        // Pick the first project if none specified
        const projectId = project ?? Object.keys(config.projects)[0];
        if (!projectId) {
          return {
            content: [{ type: "text", text: "Error: no projects configured in conductor.yaml" }],
            isError: true,
          };
        }

        if (!config.projects[projectId]) {
          const available = Object.keys(config.projects).join(", ");
          return {
            content: [
              {
                type: "text",
                text: `Error: unknown project "${projectId}". Available: ${available}`,
              },
            ],
            isError: true,
          };
        }

        const resolvedPrompt = prompt?.trim() ? prompt : task;
        const session = await sessionManager.spawn({
          projectId,
          prompt: resolvedPrompt,
          agent,
          model,
          profile,
          branch,
          baseBranch,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  sessionId: session.id,
                  projectId: session.projectId,
                  status: session.status,
                  branch: session.branch,
                  workspacePath: session.workspacePath,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: conductor_list_sessions
  // -------------------------------------------------------------------------
  server.tool(
    "conductor_list_sessions",
    "List active Conductor sessions, optionally filtered by project or status",
    {
      project: z.string().optional().describe("Filter by project ID"),
      status: z.string().optional().describe("Filter by session status (e.g. working, pr_open)"),
    },
    async ({ project, status }) => {
      try {
        const { sessionManager } = await getServices();
        let sessions = await sessionManager.list(project);

        if (status) {
          sessions = sessions.filter((s) => s.status === status);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sessions.map(serializeSession), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: conductor_session_status
  // -------------------------------------------------------------------------
  server.tool(
    "conductor_session_status",
    "Get the current status and details of a specific Conductor session",
    {
      sessionId: z.string().describe("The session ID to inspect"),
    },
    async ({ sessionId }) => {
      try {
        const { sessionManager } = await getServices();
        const session = await sessionManager.get(sessionId);

        if (!session) {
          return {
            content: [{ type: "text", text: `Session "${sessionId}" not found` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(serializeSession(session), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: conductor_list_projects
  // -------------------------------------------------------------------------
  server.tool(
    "conductor_list_projects",
    "List all projects configured in conductor.yaml",
    {},
    async () => {
      try {
        const { config } = await getServices();
        const projects = Object.entries(config.projects).map(([id, p]) =>
          serializeProject(id, p),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: conductor_kill_session
  // -------------------------------------------------------------------------
  server.tool(
    "conductor_kill_session",
    "Kill a running Conductor session (destroys runtime and workspace)",
    {
      sessionId: z.string().describe("The session ID to kill"),
    },
    async ({ sessionId }) => {
      try {
        const { sessionManager } = await getServices();

        const session = await sessionManager.get(sessionId);
        if (!session) {
          return {
            content: [{ type: "text", text: `Session "${sessionId}" not found` }],
            isError: true,
          };
        }

        await sessionManager.kill(sessionId);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, sessionId, message: "Session killed" }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Resource: conductor://projects
  // -------------------------------------------------------------------------
  server.resource(
    "conductor-projects",
    new ResourceTemplate("conductor://projects", { list: undefined }),
    async (_uri) => {
      try {
        const { config } = await getServices();
        const projects = Object.entries(config.projects).map(([id, p]) =>
          serializeProject(id, p),
        );
        return {
          contents: [
            {
              uri: "conductor://projects",
              mimeType: "application/json",
              text: JSON.stringify(projects, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: "conductor://projects",
              mimeType: "text/plain",
              text: `Error loading projects: ${String(err)}`,
            },
          ],
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Resource: conductor://sessions
  // -------------------------------------------------------------------------
  server.resource(
    "conductor-sessions",
    new ResourceTemplate("conductor://sessions", { list: undefined }),
    async (_uri) => {
      try {
        const { sessionManager } = await getServices();
        const sessions = await sessionManager.list();
        return {
          contents: [
            {
              uri: "conductor://sessions",
              mimeType: "application/json",
              text: JSON.stringify(sessions.map(serializeSession), null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          contents: [
            {
              uri: "conductor://sessions",
              mimeType: "text/plain",
              text: `Error loading sessions: ${String(err)}`,
            },
          ],
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Start function (called by the CLI command)
// ---------------------------------------------------------------------------

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
