/**
 * Conductor Webhook Plugin
 *
 * HTTP server that listens for external events and creates tasks on
 * Obsidian CONDUCTOR.md kanban boards automatically.
 *
 * Endpoints:
 *   POST /api/webhook/task   — Create a task from any source
 *   POST /api/webhook/github — Handle GitHub webhook events
 *   GET  /api/webhook/health — Health check
 *   GET  /api/webhook/status — Stats (tasks created, uptime)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { OrchestratorConfig } from "@conductor-oss/core";

// =============================================================================
// Types
// =============================================================================

export interface WebhookConfig {
  enabled: boolean;
  port: number;
  secret?: string;
}

export interface WebhookServer {
  start(): Promise<void>;
  stop(): void;
  getStats(): { tasksCreated: number; startedAt: Date };
}

// =============================================================================
// Helpers
// =============================================================================

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Constant-time HMAC-SHA256 signature verification for GitHub webhooks. */
function verifyGitHubSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/** Resolve the default workspace path. */
function defaultWorkspacePath(): string {
  return (
    process.env["CONDUCTOR_WORKSPACE"] ??
    join(process.env["HOME"] ?? "~", ".conductor", "workspace")
  );
}

/**
 * Find the best CONDUCTOR.md board path for a given project key.
 * Falls back to the first available board, then the default workspace board.
 */
function findBoardPath(
  config: OrchestratorConfig,
  projectKey?: string,
): string | null {
  const workspacePath = defaultWorkspacePath();

  if (projectKey) {
    const project = config.projects[projectKey];
    if (project) {
      const boardDir = project.boardDir ?? projectKey;
      const candidate = join(workspacePath, boardDir, "CONDUCTOR.md");
      if (existsSync(candidate)) return candidate;
    }
  }

  // First available project board
  for (const [key, project] of Object.entries(config.projects)) {
    const boardDir = project.boardDir ?? key;
    const candidate = join(workspacePath, boardDir, "CONDUCTOR.md");
    if (existsSync(candidate)) return candidate;
  }

  // Top-level workspace board
  const defaultBoard = join(workspacePath, "CONDUCTOR.md");
  if (existsSync(defaultBoard)) return defaultBoard;

  return null;
}

/**
 * Insert a task line into the Inbox section of a CONDUCTOR.md board.
 * If no "## Inbox" heading exists, one is appended.
 */
function addTaskToInbox(boardPath: string, task: string): void {
  const content = readFileSync(boardPath, "utf-8");
  const inboxIdx = content.indexOf("## Inbox");

  if (inboxIdx === -1) {
    writeFileSync(boardPath, content + `\n## Inbox\n\n- ${task}\n`);
    return;
  }

  // Insert immediately after the "## Inbox\n" line
  const insertAt = content.indexOf("\n", inboxIdx) + 1;
  const newContent =
    content.slice(0, insertAt) + `- ${task}\n` + content.slice(insertAt);
  writeFileSync(boardPath, newContent);
}

/** Append a line to conductor.log and echo to stdout. */
function logWebhook(message: string): void {
  const logDir = join(process.env["HOME"] ?? ".", ".conductor");
  const logPath = join(logDir, "conductor.log");
  const timestamp = new Date().toISOString();
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(logPath, `[${timestamp}] [webhook] ${message}\n`);
  } catch {
    /* ignore log write failures */
  }
  console.log(`[webhook] ${message}`);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

/** Find a project key whose repo name matches the GitHub repository name. */
function matchProject(
  config: OrchestratorConfig,
  repoName: string,
): string | undefined {
  for (const [key, proj] of Object.entries(config.projects)) {
    if (
      proj.repo === repoName ||
      proj.repo.endsWith(`/${repoName}`)
    ) {
      return key;
    }
  }
  return undefined;
}

// =============================================================================
// Server factory
// =============================================================================

export function createWebhookServer(
  config: OrchestratorConfig,
  webhookConfig: WebhookConfig,
): WebhookServer {
  let tasksCreated = 0;
  const startedAt = new Date();

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      try {
        // ------------------------------------------------------------------
        // GET /api/webhook/health
        // ------------------------------------------------------------------
        if (method === "GET" && url === "/api/webhook/health") {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ------------------------------------------------------------------
        // GET /api/webhook/status
        // ------------------------------------------------------------------
        if (method === "GET" && url === "/api/webhook/status") {
          sendJson(res, 200, {
            ok: true,
            tasksCreated,
            uptime: Math.floor((Date.now() - startedAt.getTime()) / 1000),
            startedAt: startedAt.toISOString(),
          });
          return;
        }

        // ------------------------------------------------------------------
        // POST /api/webhook/task — generic task creation
        // ------------------------------------------------------------------
        if (method === "POST" && url === "/api/webhook/task") {
          const raw = await readBody(req);
          let payload: {
            task?: string;
            project?: string;
            agent?: string;
            priority?: string;
            board?: string;
          };
          try {
            payload = JSON.parse(raw) as typeof payload;
          } catch {
            sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
            return;
          }

          if (!payload.task) {
            sendJson(res, 400, { ok: false, error: "task field is required" });
            return;
          }

          let taskLine = payload.task;
          if (payload.agent) taskLine += ` #agent/${payload.agent}`;
          if (payload.project) taskLine += ` #project/${payload.project}`;
          if (payload.priority) taskLine += ` #priority/${payload.priority}`;

          const boardPath = payload.board ?? findBoardPath(config, payload.project);
          if (!boardPath) {
            sendJson(res, 500, {
              ok: false,
              error: "No CONDUCTOR.md board found",
            });
            return;
          }

          addTaskToInbox(boardPath, taskLine);
          tasksCreated++;
          logWebhook(`Task created: "${taskLine}" -> ${boardPath}`);
          sendJson(res, 200, { ok: true, task: taskLine, board: boardPath });
          return;
        }

        // ------------------------------------------------------------------
        // POST /api/webhook/github — GitHub webhook events
        // ------------------------------------------------------------------
        if (method === "POST" && url === "/api/webhook/github") {
          const raw = await readBody(req);

          // Verify HMAC signature when a secret is configured
          if (webhookConfig.secret) {
            const sig = req.headers["x-hub-signature-256"] as string | undefined;
            if (!verifyGitHubSignature(raw, sig, webhookConfig.secret)) {
              sendJson(res, 401, { ok: false, error: "Invalid signature" });
              return;
            }
          }

          const event = req.headers["x-github-event"] as string | undefined;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
            return;
          }

          const action = payload["action"] as string | undefined;
          let taskLine: string | null = null;
          let projectKey: string | undefined;

          const repoObj = payload["repository"] as Record<string, unknown> | undefined;
          const repoName = (repoObj?.["name"] as string | undefined) ?? "";
          if (repoName) {
            projectKey = matchProject(config, repoName);
          }
          const projectTag = projectKey ? ` #project/${projectKey}` : "";

          // ---- issues.opened ----
          if (event === "issues" && action === "opened") {
            const issue = payload["issue"] as Record<string, unknown> | undefined;
            const issueNum = issue?.["number"] as number | undefined;
            const title = (issue?.["title"] as string | undefined) ?? "New issue";
            const body = (issue?.["body"] as string | undefined) ?? "";

            const issueTag = issueNum ? ` #issue/${issueNum}` : "";
            taskLine = `${title}${issueTag}${projectTag}`;
            if (body.trim()) {
              const preview = body.slice(0, 200).replace(/\n+/g, " ").trim();
              taskLine += ` — ${preview}`;
            }
          }

          // ---- issue_comment.created with /conductor command ----
          if (event === "issue_comment" && action === "created") {
            const comment = payload["comment"] as Record<string, unknown> | undefined;
            const commentBody = (comment?.["body"] as string | undefined) ?? "";
            if (commentBody.trim().startsWith("/conductor")) {
              const taskText = commentBody
                .replace(/^\/conductor\s*/m, "")
                .trim();
              if (taskText) {
                taskLine = `${taskText}${projectTag}`;
              }
            }
          }

          // ---- pull_request_review with changes_requested ----
          if (event === "pull_request_review" && action === "submitted") {
            const review = payload["review"] as Record<string, unknown> | undefined;
            const state = (review?.["state"] as string | undefined)?.toLowerCase();
            if (state === "changes_requested") {
              const pr = payload["pull_request"] as Record<string, unknown> | undefined;
              const prNum = pr?.["number"] as number | undefined;
              taskLine = `Address PR review for #${prNum}${projectTag}`;
            }
          }

          if (!taskLine) {
            sendJson(res, 200, { ok: true, skipped: true, event, action });
            return;
          }

          const boardPath = findBoardPath(config, projectKey);
          if (!boardPath) {
            sendJson(res, 500, { ok: false, error: "No CONDUCTOR.md board found" });
            return;
          }

          addTaskToInbox(boardPath, taskLine);
          tasksCreated++;
          logWebhook(`GitHub ${event}/${action}: "${taskLine}" -> ${boardPath}`);
          sendJson(res, 200, { ok: true, task: taskLine, board: boardPath });
          return;
        }

        // 404
        sendJson(res, 404, { ok: false, error: "Not found" });
      } catch (err) {
        console.error("[webhook] Unhandled error:", err);
        sendJson(res, 500, { ok: false, error: "Internal server error" });
      }
    },
  );

  return {
    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.listen(webhookConfig.port, () => {
          logWebhook(`Listening on port ${webhookConfig.port}`);
          resolve();
        });
        server.on("error", reject);
      });
    },

    stop(): void {
      server.close();
      logWebhook("Server stopped");
    },

    getStats() {
      return { tasksCreated, startedAt };
    },
  };
}
