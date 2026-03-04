import { type NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { OrchestratorConfig } from "@conductor-oss/core";
import {
  buildBoardProjectMap,
  discoverBoards,
  parseBoardSections,
  parseChecklistItems,
  resolveBoardAliasesForPath,
  resolveColumnsFromBoard,
} from "@conductor-oss/core";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

type BoardRole = "intake" | "ready" | "dispatching" | "inProgress" | "review" | "done" | "blocked";

type BoardTask = {
  id: string;
  text: string;
  checked: boolean;
  agent: string | null;
  project: string | null;
  type: string | null;
  priority: string | null;
  taskRef: string | null;
  attemptRef: string | null;
};

type BoardColumn = {
  role: BoardRole;
  heading: string;
  tasks: BoardTask[];
};

const BOARD_ROLE_ORDER: BoardRole[] = ["intake", "ready", "dispatching", "inProgress", "review", "done", "blocked"];
const PRIMARY_BOARD_ROLES: BoardRole[] = ["intake", "inProgress", "review", "done"];
type ProjectConfig = OrchestratorConfig["projects"][string];
type ProjectEntry = { id: string; project: ProjectConfig };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function constrainToWorkspacePath(workspacePath: string, candidatePath: string): string {
  const workspaceRoot = resolve(workspacePath);
  const candidate = resolve(candidatePath);
  const workspacePrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (candidate !== workspaceRoot && !candidate.startsWith(workspacePrefix)) {
    throw new Error("Resolved path escapes workspace root");
  }
  return candidate;
}

function normalizeToken(value: string): string {
  const input = value.trim().toLowerCase();
  let output = "";
  let prevDash = false;

  for (const char of input) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAlpha = code >= 97 && code <= 122;
    const isSafeLiteral = char === "." || char === "_" || isDigit || isLowerAlpha;

    if (isSafeLiteral) {
      output += char;
      prevDash = false;
      continue;
    }

    if (!prevDash && output.length > 0) {
      output += "-";
      prevDash = true;
    }
  }

  while (output.endsWith("-")) {
    output = output.slice(0, -1);
  }

  return output;
}

function lastPathSegment(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function projectDirectorySegment(projectEntry: ProjectEntry): string {
  const configuredBoardDir = typeof projectEntry.project.boardDir === "string"
    ? lastPathSegment(projectEntry.project.boardDir)
    : "";
  const pathBase = lastPathSegment(basename(projectEntry.project.path));
  const rawSegment = configuredBoardDir || pathBase || projectEntry.id;
  const normalized = normalizeToken(rawSegment);
  return normalized || "project";
}

function normalizeTag(value: string): string {
  return normalizeToken(value);
}

function findProjectEntry(config: OrchestratorConfig, requestedProjectId: string): ProjectEntry | null {
  for (const [id, project] of Object.entries(config.projects)) {
    if (id === requestedProjectId) {
      return { id, project };
    }
  }
  return null;
}

function resolveWorkspacePath(config: OrchestratorConfig): string {
  if (process.env["CONDUCTOR_WORKSPACE"]?.trim()) {
    return expandHome(process.env["CONDUCTOR_WORKSPACE"]);
  }

  if (config.configPath) {
    return dirname(config.configPath);
  }

  return resolve(process.cwd());
}

function resolveProjectBoardPath(config: OrchestratorConfig, projectEntry: ProjectEntry, workspacePath: string): string {
  const workspaceRoot = resolve(workspacePath);
  const boards = discoverBoards(workspaceRoot, config.boards?.length ? config.boards : config);
  const boardMap = buildBoardProjectMap(boards, config);
  const mappedPath = boards.find((path) => boardMap.get(path) === projectEntry.id);
  if (mappedPath) {
    const safeMappedPath = constrainToWorkspacePath(workspaceRoot, mappedPath);
    if (existsSync(safeMappedPath)) return safeMappedPath;
  }

  // Only use a sanitized project-id segment for new board path creation.
  // Existing custom board files are still handled above via board discovery mapping.
  const fallbackSegment = projectDirectorySegment(projectEntry);

  const preferredProjectBoard = constrainToWorkspacePath(
    workspaceRoot,
    join(workspaceRoot, "projects", fallbackSegment, "CONDUCTOR.md"),
  );
  const localProjectBoard = constrainToWorkspacePath(
    workspaceRoot,
    join(workspaceRoot, fallbackSegment, "CONDUCTOR.md"),
  );
  if (existsSync(preferredProjectBoard)) return preferredProjectBoard;
  if (existsSync(localProjectBoard)) return localProjectBoard;
  return preferredProjectBoard;
}

function buildStarterBoard(projectId: string, headings: Record<BoardRole, string>): string {
  const title = projectId.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());

  return [
    `# ${title} Board`,
    "",
    "<!-- Managed by conductor dashboard and Obsidian board watcher -->",
    "",
    `## ${headings.intake}`,
    "",
    `## ${headings.ready}`,
    "",
    `## ${headings.dispatching}`,
    "",
    `## ${headings.inProgress}`,
    "",
    `## ${headings.review}`,
    "",
    `## ${headings.done}`,
    "",
    `## ${headings.blocked}`,
    "",
  ].join("\n");
}

async function readOrInitializeBoard(
  config: OrchestratorConfig,
  projectEntry: ProjectEntry,
  workspacePath: string,
): Promise<{ boardPath: string; content: string; columnsByRole: Record<BoardRole, string> }> {
  const unresolvedBoardPath = resolveProjectBoardPath(config, projectEntry, workspacePath);
  const boardPath = constrainToWorkspacePath(workspacePath, unresolvedBoardPath);
  const aliases = resolveBoardAliasesForPath(config, workspacePath, boardPath);

  let content: string;
  if (!existsSync(boardPath)) {
    await mkdir(dirname(boardPath), { recursive: true });
    const headings = {
      intake: aliases.intake[0] ?? "Inbox",
      ready: aliases.ready[0] ?? "Ready to Dispatch",
      dispatching: aliases.dispatching[0] ?? "Dispatching",
      inProgress: aliases.inProgress[0] ?? "In Progress",
      review: aliases.review[0] ?? "Review",
      done: aliases.done[0] ?? "Done",
      blocked: aliases.blocked[0] ?? "Blocked",
    };
    content = buildStarterBoard(projectEntry.id, headings);
    await writeFile(boardPath, content, "utf8");
  } else {
    content = await readFile(boardPath, "utf8");
  }

  const resolved = resolveColumnsFromBoard(content, aliases);
  return {
    boardPath,
    content,
    columnsByRole: resolved.columnsByRole as Record<BoardRole, string>,
  };
}

function extractTag(text: string, key: string): string | null {
  const match = text.match(new RegExp(`#${key}/([\\w.-]+)`, "i"));
  return match?.[1] ?? null;
}

function extractMarker(text: string, marker: "task" | "attempt"): string | null {
  const match = text.match(new RegExp(`\\[${marker}:([^\\]]+)\\]`, "i"));
  return match?.[1]?.trim() ?? null;
}

function cleanCardText(text: string): string {
  return text
    .replace(/\s*\[(task|attempt|parent):[^\]]+\]/gi, "")
    .replace(/\s*#(project|agent|type|priority)\/[\w.-]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashTaskId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex").slice(0, 12);
}

function parseColumns(content: string, columnsByRole: Record<BoardRole, string>): BoardColumn[] {
  const sections = parseBoardSections(content);
  const byHeading = new Map(sections.map((section) => [section.heading, section]));

  return BOARD_ROLE_ORDER.map((role) => {
    const heading = columnsByRole[role];
    const section = byHeading.get(heading);
    const tasks: BoardTask[] = section
      ? parseChecklistItems(section).map((item) => {
          const taskRef = extractMarker(item.text, "task");
          const attemptRef = extractMarker(item.text, "attempt");
          const cleaned = cleanCardText(item.text);
          const seed = `${role}:${section.heading}:${item.lineOffset}:${item.text}`;

          return {
            id: taskRef ?? hashTaskId(seed),
            text: cleaned,
            checked: item.checked,
            agent: extractTag(item.text, "agent"),
            project: extractTag(item.text, "project"),
            type: extractTag(item.text, "type"),
            priority: extractTag(item.text, "priority"),
            taskRef,
            attemptRef,
          };
        })
      : [];

    return {
      role,
      heading,
      tasks,
    };
  });
}

function insertTaskLine(content: string, heading: string, line: string): string {
  const lines = content.split("\n");
  const sections = parseBoardSections(content);
  const target = sections.find((section) => section.heading === heading);

  if (!target) {
    const trimmed = content.trimEnd();
    if (trimmed.length === 0) {
      return `## ${heading}\n\n${line}\n`;
    }
    return `${trimmed}\n\n## ${heading}\n\n${line}\n`;
  }

  const insertIndex = target.bodyStartLine;
  lines.splice(insertIndex, 0, line);
  return lines.join("\n");
}

function buildTaskLine(params: {
  title: string;
  description: string | null;
  projectId: string;
  agent: string;
  type: string | null;
  priority: string | null;
}): string {
  const details = params.description ? `${params.title} - ${params.description}` : params.title;
  const tags = [
    `#project/${normalizeTag(params.projectId)}`,
    `#agent/${normalizeTag(params.agent)}`,
  ];

  if (params.type) tags.push(`#type/${normalizeTag(params.type)}`);
  if (params.priority) tags.push(`#priority/${normalizeTag(params.priority)}`);

  return `- [ ] ${details} ${tags.join(" ")}`.trim();
}

/** GET /api/boards?projectId=<id> -- Return parsed kanban board for a project. */
export async function GET(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;

  const projectId = asNonEmptyString(request.nextUrl.searchParams.get("projectId"));
  if (!projectId) {
    return NextResponse.json({ error: "projectId query param is required" }, { status: 400 });
  }

  try {
    const { config } = await getServices();
    const projectEntry = findProjectEntry(config, projectId);
    if (!projectEntry) {
      return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
    }
    const canonicalProjectId = projectEntry.id;

    const workspacePath = resolveWorkspacePath(config);
    const { boardPath, content, columnsByRole } = await readOrInitializeBoard(
      config,
      projectEntry,
      workspacePath,
    );
    const columns = parseColumns(content, columnsByRole);

    return NextResponse.json({
      projectId: canonicalProjectId,
      boardPath,
      workspacePath,
      columns,
      primaryRoles: PRIMARY_BOARD_ROLES,
      watcherHint: "Move cards to Ready to Dispatch to let Obsidian watcher spawn agents.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load board" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/boards -- Add a task card to a project board.
 * Body: { projectId, title, description?, agent, role?, type?, priority? }
 */
export async function POST(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const projectId = asNonEmptyString(body.projectId);
  const title = asNonEmptyString(body.title);
  const description = asNonEmptyString(body.description);
  const agent = asNonEmptyString(body.agent);
  const requestedRole = asNonEmptyString(body.role);
  const type = asNonEmptyString(body.type);
  const priority = asNonEmptyString(body.priority);

  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (!agent) {
    return NextResponse.json({ error: "agent is required" }, { status: 400 });
  }

  const role = (requestedRole && BOARD_ROLE_ORDER.includes(requestedRole as BoardRole)
    ? requestedRole
    : "intake") as BoardRole;

  try {
    const { config } = await getServices();
    const projectEntry = findProjectEntry(config, projectId);
    if (!projectEntry) {
      return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
    }
    const canonicalProjectId = projectEntry.id;

    const workspacePath = resolveWorkspacePath(config);
    const { boardPath, content, columnsByRole } = await readOrInitializeBoard(
      config,
      projectEntry,
      workspacePath,
    );
    const heading = columnsByRole[role];
    const line = buildTaskLine({
      title,
      description,
      projectId: canonicalProjectId,
      agent,
      type,
      priority,
    });

    const updated = insertTaskLine(content, heading, line);
    await writeFile(boardPath, updated, "utf8");

    const columns = parseColumns(updated, columnsByRole);
    return NextResponse.json({
      projectId: canonicalProjectId,
      boardPath,
      columns,
      primaryRoles: PRIMARY_BOARD_ROLES,
      created: {
        role,
        heading,
        line,
      },
    }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create board task" },
      { status: 500 },
    );
  }
}
