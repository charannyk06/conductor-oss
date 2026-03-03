import { NextResponse } from "next/server";
import { accessSync, constants, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, isAbsolute } from "node:path";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { getServices } from "@/lib/services";
import { guardApiAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

type AgentInfo = {
  name: string;
  description: string | null;
  version: string | null;
};

const PATH_AGENT_HINTS: Array<{ name: string; commands: string[]; aliases?: string[]; description: string }> = [
  {
    name: "claude-code",
    commands: ["claude", "claude-code", "claude-cli", "cc"],
    aliases: ["cc", "claude", "claude_code", "claude code"],
    description: "Claude Code CLI",
  },
  {
    name: "codex",
    commands: ["codex", "openai-codex", "openai-codex-cli", "codex-cli"],
    aliases: ["openai-codex", "openai_codex", "openai", "open ai", "openai-codex-cli"],
    description: "OpenAI Codex CLI",
  },
  {
    name: "gemini",
    commands: ["gemini", "gemini-cli", "google-gemini"],
    aliases: ["google-gemini", "google_gemini", "gm", "gemini cli"],
    description: "Google Gemini CLI",
  },
  {
    name: "amp",
    commands: ["amp", "amp-cli"],
    aliases: ["amp-cli", "amp cli"],
    description: "Amp Code CLI",
  },
  {
    name: "cursor-cli",
    commands: ["cursor", "cursor-cli"],
    aliases: ["cursor-agent", "cursor_agent", "cursor cli", "cursoragent"],
    description: "Cursor Agent CLI",
  },
  {
    name: "opencode",
    commands: ["opencode", "open-code"],
    aliases: ["open code", "open-code", "open_code", "open-code-cli"],
    description: "OpenCode CLI",
  },
  {
    name: "droid",
    commands: ["droid"],
    aliases: ["factory-droid", "factory_droid"],
    description: "Factory Droid CLI",
  },
  {
    name: "qwen-code",
    commands: ["qwen-code"],
    aliases: ["qwen", "qwen code", "qwen-code-cli"],
    description: "Qwen Code CLI",
  },
  {
    name: "ccr",
    commands: ["ccr"],
    aliases: ["claude-code-router", "ccr"],
    description: "Claude Code Router",
  },
  {
    name: "github-copilot",
    commands: ["github-copilot", "copilot", "gh-copilot"],
    aliases: ["copilot-cli", "github-copilot-cli", "gh-copilot", "github copilot"],
    description: "GitHub Copilot CLI",
  },
];

function normalizeAgentName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique<T>(items: T[]): T[] {
  return [...new Map(items.map((item) => [String(item), item])).values()];
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getBinarySearchPaths(): string[] {
  const envPath = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  const candidates: string[] = [...envPath];

  if (process.platform === "win32") {
    candidates.push(
      join(homedir(), "AppData", "Roaming", "npm"),
      join(homedir(), "AppData", "Local", "fnm_multishells", "current"),
      join(homedir(), ".bun", "bin"),
      join(homedir(), ".yarn", "bin"),
    );
  } else {
    candidates.push(
      join(homedir(), ".npm-global", "bin"),
      join(homedir(), ".npm", "bin"),
      join(homedir(), ".local", "bin"),
      join(homedir(), ".yarn", "bin"),
      join(homedir(), ".bun", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/usr/local/sbin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
    );
  }

  const unique = new Map<string, string>();
  for (const candidate of candidates) {
    const dir = candidate.trim();
    if (!dir) continue;
    unique.set(resolve(dir), dir);
  }
  return [...unique.values()];
}

function expandHomePath(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

function resolveAbsoluteCommand(candidate: string): string | undefined {
  const trimmed = expandHomePath(candidate.trim());
  if (!trimmed) return undefined;

  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    const candidatePath = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
    if (existsSync(candidatePath) && isExecutableFile(candidatePath)) {
      return candidatePath;
    }
    return undefined;
  }

  return undefined;
}

function findInPath(command: string): string | undefined {
  if (!command) return undefined;
  const commandPath = resolveAbsoluteCommand(command);
  if (commandPath) {
    return commandPath;
  }

  const pathDirs = getBinarySearchPaths();
  if (pathDirs.length === 0) return undefined;

  const extensions = process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean)
    : [""];

  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidates = extensions.length === 0 ? [command] :
      extensions.map((ext) => `${command}${ext}`);

    for (const relative of candidates) {
      const candidate = join(dir, relative);
      if (existsSync(candidate) && isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function addHintCommands(
  bindings: Map<string, { displayNames: Set<string>; descriptions: Set<string> }>,
  command: string,
  displayName: string,
  description: string,
) {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return;
  const target = bindings.get(trimmedCommand) ?? { displayNames: new Set(), descriptions: new Set() };
  target.displayNames.add(displayName);
  target.descriptions.add(description);
  bindings.set(trimmedCommand, target);
}

function resolveHintEntries(value: string): Array<{ command: string; name: string; description: string }> {
  const normalized = normalizeAgentName(value);
  if (!normalized) return [];

  return PATH_AGENT_HINTS.flatMap((hint) => {
    const normalizedMatches = [
      normalizeAgentName(hint.name),
      ...(hint.aliases ?? []).map((alias) => normalizeAgentName(alias)),
      ...hint.commands.map((command) => normalizeAgentName(command)),
    ];

    if (!normalizedMatches.includes(normalized)) return [];
    return hint.commands.map((command) => ({ command, name: hint.name, description: hint.description }));
  });
}

async function detectVersion(command: string): Promise<string | null> {
  try {
    const result = await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      timeout: 900,
      windowsHide: true,
      maxBuffer: 32_768,
    }) as { stdout: string; stderr: string };

    const output = [result.stdout ?? "", result.stderr ?? ""]
      .join("\n")
      .trim();

    if (!output) {
      return null;
    }

    return output.split(/[\r\n]/)[0].trim() || null;
  } catch {
    return null;
  }
}

function collectConfiguredAgents(config: { projects: Record<string, { agent?: string }> }): string[] {
  const names = new Set<string>();
  for (const project of Object.values(config.projects)) {
    if (!project?.agent) continue;
    const normalized = normalizeAgentName(project.agent);
    if (normalized) {
      names.add(normalized);
    }
  }
  return [...names];
}

async function collectBinaryAgents(candidates: string[]): Promise<AgentInfo[]> {
  const discovered = new Map<string, AgentInfo>();
  const bindings = new Map<string, { displayNames: Set<string>; descriptions: Set<string> }>();

  for (const candidate of candidates) {
    const trimmedCandidate = candidate.trim();
    if (!trimmedCandidate) continue;

    const hintBindings = resolveHintEntries(trimmedCandidate);
    if (hintBindings.length > 0) {
      for (const hintBinding of hintBindings) {
        addHintCommands(
          bindings,
          hintBinding.command,
          hintBinding.name,
          hintBinding.description,
        );
      }
      continue;
    }

    const candidateVariants = unique([
      trimmedCandidate,
      trimmedCandidate.replace(/_/g, "-"),
      trimmedCandidate.replace(/-/g, "_"),
      trimmedCandidate.replace(/\s+/g, "-"),
      trimmedCandidate.replace(/\s+/g, "_"),
    ]);

    for (const command of candidateVariants) {
      addHintCommands(bindings, command, trimmedCandidate, `Detected binary: ${trimmedCandidate}`);
    }
  }

  const discoveredEntries = await Promise.all(
    [...bindings].map(async ([command, info]) => {
      const resolved = findInPath(command);
      if (!resolved) return null;

      const version = await detectVersion(resolved);
      return { command, resolved, info, version };
    }),
  );

  for (const entry of discoveredEntries) {
    if (!entry) continue;

    const { info, version } = entry;
    const description = [...info.descriptions][0] ?? null;

    for (const displayName of info.displayNames) {
      const key = normalizeAgentName(displayName);
      if (!key) continue;

      const existing = discovered.get(key);
      if (!existing) {
        discovered.set(key, {
          name: displayName,
          description: description ?? `Detected binary: ${displayName}`,
          version,
        });
        continue;
      }

      if (!existing.version && version) {
        existing.version = version;
      }
      if (!existing.description && description) {
        existing.description = description;
      }
    }
  }

  return [...discovered.values()];
}

export async function GET() {
  const denied = await guardApiAccess();
  if (denied) return denied;

  try {
    const { registry, config } = await getServices();
    const dedupe = new Map<string, AgentInfo>();

    for (const manifest of registry.list("agent")) {
      const key = normalizeAgentName(manifest.name);
      if (!key) continue;
      dedupe.set(key, {
        name: manifest.name,
        description: manifest.description ?? null,
        version: manifest.version ?? null,
      });
    }

    const configuredAgentNames = collectConfiguredAgents(config);

    for (const agentName of configuredAgentNames) {
      const key = normalizeAgentName(agentName);
      if (!key) continue;
      if (!dedupe.has(key)) {
        dedupe.set(key, {
          name: agentName,
          description: "Configured in conductor.yaml",
          version: null,
        });
      }
    }

    const binaryCandidates = new Set<string>([
      ...configuredAgentNames,
      ...PATH_AGENT_HINTS.map((hint) => hint.name),
      ...dedupe.keys(),
    ]);

    const discoveredBinaryAgents = await collectBinaryAgents([...binaryCandidates]);
    for (const discovered of discoveredBinaryAgents) {
      const key = normalizeAgentName(discovered.name);
      if (!key) continue;
      const existing = dedupe.get(key);
      if (!existing) {
        dedupe.set(key, discovered);
        continue;
      }
      if (!existing.version && discovered.version) {
        existing.version = discovered.version;
      }
      if (!existing.description && discovered.description) {
        existing.description = discovered.description;
      }
    }

    return NextResponse.json({ agents: [...dedupe.values()] });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load agents" },
      { status: 500 },
    );
  }
}
