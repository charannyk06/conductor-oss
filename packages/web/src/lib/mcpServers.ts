/** Client-side model for the MCP Servers settings tab. */

/** Value the backend returns in place of stored environment values. */
export const MASKED_ENV_VALUE = "••••••••";

export type McpServer = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  enabled: boolean;
};

/** Editable form of a server: args and env are edited as text. */
export type McpServerDraft = {
  key: string;
  name: string;
  command: string;
  argsText: string;
  envText: string;
  cwd: string;
  enabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeMcpServers(payload: unknown): McpServer[] {
  const servers = isRecord(payload) ? payload["servers"] : null;
  if (!Array.isArray(servers)) return [];
  return servers.flatMap((raw): McpServer[] => {
    if (!isRecord(raw) || typeof raw["name"] !== "string" || typeof raw["command"] !== "string") {
      return [];
    }
    const env: Record<string, string> = {};
    if (isRecord(raw["env"])) {
      for (const [key, value] of Object.entries(raw["env"])) {
        if (typeof value === "string") env[key] = value;
      }
    }
    return [{
      name: raw["name"],
      command: raw["command"],
      args: Array.isArray(raw["args"])
        ? raw["args"].filter((arg): arg is string => typeof arg === "string")
        : [],
      env,
      cwd: typeof raw["cwd"] === "string" && raw["cwd"].trim() ? raw["cwd"] : null,
      enabled: raw["enabled"] !== false,
    }];
  });
}

/** Split a command line into arguments, honouring single and double quotes. */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
  }
  if (started || current) args.push(current);
  return args;
}

export function formatArgs(args: string[]): string {
  return args
    .map((arg) => (arg === "" || /[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(" ");
}

/** Parse `KEY=value` lines. Blank lines and lines without a key are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    env[key] = trimmed.slice(separator + 1).trim();
  }
  return env;
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function serverToDraft(server: McpServer, key: string): McpServerDraft {
  return {
    key,
    name: server.name,
    command: server.command,
    argsText: formatArgs(server.args),
    envText: formatEnv(server.env),
    cwd: server.cwd ?? "",
    enabled: server.enabled,
  };
}

export function emptyDraft(key: string): McpServerDraft {
  return { key, name: "", command: "", argsText: "", envText: "", cwd: "", enabled: true };
}

export function draftToServer(draft: McpServerDraft): McpServer {
  return {
    name: draft.name.trim(),
    command: draft.command.trim(),
    args: parseArgs(draft.argsText),
    env: parseEnv(draft.envText),
    cwd: draft.cwd.trim() || null,
    enabled: draft.enabled,
  };
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** First problem that would make the backend reject the set, or null when it is valid. */
export function validateDrafts(drafts: McpServerDraft[]): string | null {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) return "Every MCP server needs a name.";
    if (!SERVER_NAME_PATTERN.test(name)) {
      return `"${name}" is not a valid name. Use letters, numbers, "-" and "_".`;
    }
    if (name.toLowerCase() === "conductor") {
      return `"conductor" is reserved for Conductor's built-in MCP server.`;
    }
    if (seen.has(name)) return `"${name}" is listed twice.`;
    seen.add(name);
    if (!draft.command.trim()) return `"${name}" needs a command.`;
  }
  return null;
}
