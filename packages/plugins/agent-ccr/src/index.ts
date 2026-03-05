/**
 * Claude Code Router plugin.
 */

import { shellEscape } from "@conductor-oss/core";
import type {
  Agent,
  AgentLaunchConfig,
  AgentSessionInfo,
  ActivityState,
  ActivityDetection,
  PluginModule,
  RuntimeHandle,
  Session,
  WorkspaceHooksConfig,
} from "@conductor-oss/core";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BINS = ["ccr"] as const;

function findAgentBin(): string {
  const candidates = [
    process.env["CCR_BIN"],
    ...BINS.flatMap((name) => [
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
      `/bin/${name}`,
    ]),
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }

  return BINS[0] ?? "ccr";
}

const AGENT_BIN = findAgentBin();

function findTmuxBin(): string {
  const candidates = [
    process.env["TMUX_BIN"],
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
    "/bin/tmux",
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }

  return "tmux";
}

const TMUX_BIN = findTmuxBin();

async function captureTmuxPane(handle: RuntimeHandle, lines = 30): Promise<string | null> {
  if (handle.runtimeName !== "tmux" || !handle.id) return null;
  try {
    const { stdout } = await execFileAsync(
      TMUX_BIN,
      ["capture-pane", "-t", handle.id, "-p", "-l", String(lines)],
      { timeout: 5_000 },
    );
    return stdout;
  } catch {
    return null;
  }
}

function classifyTerminalOutput(terminalOutput: string): ActivityState {
  if (!terminalOutput.trim()) return "idle";

  const lines = terminalOutput.trim().split("\n");
  const lastNonEmpty = [...lines].reverse().find((line) => line.trim() !== "")?.trim() ?? "";

  if (/^[❯>$#]\s*$/.test(lastNonEmpty)) return "idle";

  const tail = lines.slice(-8).join("\n");
  if (/\(y\)es.*\(n\)o/i.test(tail)) return "waiting_input";
  if (/do you want|confirm|approve|proceed/i.test(tail)) return "waiting_input";
  if (/^(done|complete|finished|exiting)/i.test(lastNonEmpty)) return "idle";

  return "active";
}

function escapeRegExpValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function processMatchesRuntime(handle: RuntimeHandle): Promise<number | null> {
  const processName = "ccr";
  try {
    if (handle.runtimeName === "tmux" && handle.id) {
      const { stdout: ttyOut } = await execFileAsync(
        TMUX_BIN,
        ["list-panes", "-t", handle.id, "-F", "#{pane_tty}"],
        { timeout: 30_000 },
      );
      const ttys = ttyOut
        .trim()
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean);
      if (ttys.length === 0) return null;

      const { stdout: psOut } = await execFileAsync("ps", ["-eo", "pid,tty,args"], {
        timeout: 30_000,
      });
      const ttySet = new Set(ttys.map((t) => t.replace(/^\/dev\//, "")));
      const escapedProcess = escapeRegExpValue(processName);
      const processRe = new RegExp(`(?:^|/)${escapedProcess}(?:\\s|$)`);

      for (const line of psOut.split("\n")) {
        const cols = line.trimStart().split(/\s+/);
        if (cols.length < 3 || !ttySet.has(cols[1] ?? "")) continue;
        const args = cols.slice(2).join(" ");
        if (processRe.test(args)) return parseInt(cols[0] ?? "0", 10);
      }
      return null;
    }

    const rawPid = handle.data["pid"];
    const pid = typeof rawPid === "number" ? rawPid : Number(rawPid);
    if (!Number.isFinite(pid) || pid <= 0) return null;

    try {
      process.kill(pid, 0);
      return pid;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM") {
        return pid;
      }
      return null;
    }
  } catch {
    return null;
  }
}

export const manifest = {
  name: "ccr",
  slot: "agent" as const,
  description: "Agent plugin: Claude Code Router",
  version: "0.2.0",
};

function createAgent(): Agent {
  return {
    name: "ccr",
    processName: "ccr",
    promptDelivery: "inline",

    getLaunchCommand(config: AgentLaunchConfig): string {
      const parts: string[] = [AGENT_BIN];
      if (config.prompt) {
        parts.push(shellEscape(config.prompt));
      }
      return parts.join(" ");
    },

    getEnvironment(config: AgentLaunchConfig): Record<string, string> {
      const env: Record<string, string> = {};
      env["CO_SESSION_ID"] = config.sessionId;
      if (config.issueId) {
        env["CO_ISSUE_ID"] = config.issueId;
      }
      return env;
    },

    detectActivity(terminalOutput: string): ActivityState {
      return classifyTerminalOutput(terminalOutput);
    },

    async getActivityState(session: Session): Promise<ActivityDetection | null> {
      const timestamp = new Date();
      if (!session.runtimeHandle) return { state: "exited", timestamp };

      const pid = await processMatchesRuntime(session.runtimeHandle);
      if (!pid) return { state: "exited", timestamp };

      const output = await captureTmuxPane(session.runtimeHandle);
      if (!output) {
        return { state: "active", timestamp };
      }

      const detected = classifyTerminalOutput(output);
      return { state: detected === "idle" ? "ready" : detected, timestamp };
    },

    async isProcessRunning(handle: RuntimeHandle): Promise<boolean> {
      const pid = await processMatchesRuntime(handle);
      return pid !== null;
    },

    async getSessionInfo(session: Session): Promise<AgentSessionInfo | null> {
      if (!session.runtimeHandle) return null;
      const output = await captureTmuxPane(session.runtimeHandle, 80);
      if (!output) return null;

      const lines = output
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .filter((line) => !/^[❯>$#]\s*$/.test(line));

      const summary = lines.slice(-1)[0] ?? null;
      if (!summary) return null;

      return {
        summary: summary.substring(0, 280),
        summaryIsFallback: true,
        agentSessionId: session.id,
      };
    },

    async getRestoreCommand(): Promise<null> {
      return null;
    },

    async setupWorkspaceHooks(_workspacePath: string, _config: WorkspaceHooksConfig): Promise<void> {
      return;
    },
  };
}

export function create(): Agent {
  return createAgent();
}

export default { manifest, create } satisfies PluginModule<Agent>;
