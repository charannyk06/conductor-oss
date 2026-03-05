/**
 * runtime-tmux plugin — tmux sessions as the execution runtime.
 *
 * Requires tmux to be installed and available in PATH.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PluginModule,
  Runtime,
  RuntimeCreateConfig,
  RuntimeHandle,
  AttachInfo,
} from "@conductor-oss/core";

const execFileAsync = promisify(execFile);

/** Resolve the tmux binary path. Checks common locations, falls back to PATH. */
function findTmuxBin(): string {
  const candidates = [
    process.env["TMUX_BIN"],
    "/opt/homebrew/bin/tmux",  // macOS ARM (Homebrew)
    "/usr/local/bin/tmux",     // macOS Intel (Homebrew)
    "/usr/bin/tmux",           // Linux
    "/bin/tmux",               // Linux (some distros)
  ].filter(Boolean) as string[];

  for (const bin of candidates) {
    if (existsSync(bin)) return bin;
  }

  // Fall back to bare "tmux" — let the system PATH resolve it
  return "tmux";
}

const TMUX_BIN = findTmuxBin();

export const manifest = {
  name: "tmux",
  slot: "runtime" as const,
  description: "Runtime plugin: tmux sessions",
  version: "0.2.0",
};

/** Only allow safe characters in session IDs */
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(id: string): void {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error(`Invalid session ID "${id}": must match ${SAFE_SESSION_ID}`);
  }
}

/** Run a tmux command and return stdout */
async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 30_000 });
  return stdout.trimEnd();
}

export function create(): Runtime {
  return {
    name: "tmux",

    async create(config: RuntimeCreateConfig): Promise<RuntimeHandle> {
      assertValidSessionId(config.sessionId);
      const sessionName = config.sessionId;

      // Build environment flags: -e KEY=VALUE for each env var
      const envArgs: string[] = [];
      for (const [key, value] of Object.entries(config.environment ?? {})) {
        envArgs.push("-e", `${key}=${value}`);
      }

      // Create tmux session in detached mode
      await tmux("new-session", "-d", "-s", sessionName, "-c", config.workspacePath, ...envArgs);

      // Send the launch command — clean up the session if this fails.
      // Use load-buffer + paste-buffer for long commands to avoid tmux/zsh
      // truncation issues (commands >200 chars get mangled by send-keys).
      try {
        if (config.launchCommand.length > 200) {
          const bufferName = `claw-launch-${randomUUID().slice(0, 8)}`;
          const tmpPath = join(tmpdir(), `claw-launch-${randomUUID()}.txt`);
          writeFileSync(tmpPath, config.launchCommand, { encoding: "utf-8", mode: 0o600 });
          try {
            await tmux("load-buffer", "-b", bufferName, tmpPath);
            await tmux("paste-buffer", "-b", bufferName, "-t", sessionName, "-d");
          } finally {
            try {
              unlinkSync(tmpPath);
            } catch {
              /* ignore cleanup errors */
            }
          }
          await sleep(300);
          await tmux("send-keys", "-t", sessionName, "Enter");
        } else {
          await tmux("send-keys", "-t", sessionName, config.launchCommand, "Enter");
        }
      } catch (err: unknown) {
        try {
          await tmux("kill-session", "-t", sessionName);
        } catch {
          // Best-effort cleanup
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to send launch command to session "${sessionName}": ${msg}`, {
          cause: err,
        });
      }

      // Auto-dismiss onboarding prompts (Claude Code theme/login/setup screens).
      // Claude shows 2-3 "Press Enter to continue" screens on first launch.
      // We send Enter at intervals covering the full onboarding flow.
      for (const delayMs of [8_000, 12_000, 16_000, 20_000, 25_000, 30_000]) {
        void sleep(delayMs).then(() =>
          tmux("send-keys", "-t", sessionName, "Enter").catch(() => {})
        );
      }

      return {
        id: sessionName,
        runtimeName: "tmux",
        data: {
          createdAt: Date.now(),
          workspacePath: config.workspacePath,
        },
      };
    },

    async destroy(handle: RuntimeHandle): Promise<void> {
      try {
        await tmux("kill-session", "-t", handle.id);
      } catch {
        // Session may already be dead — that's fine
      }
    },

    async sendMessage(handle: RuntimeHandle, message: string): Promise<void> {
      // Clear any partial input
      await tmux("send-keys", "-t", handle.id, "C-u");

      // For long or multiline messages, use load-buffer + paste-buffer
      if (message.includes("\n") || message.length > 200) {
        const bufferName = `claw-${randomUUID()}`;
        const tmpPath = join(tmpdir(), `claw-send-${randomUUID()}.txt`);
        writeFileSync(tmpPath, message, { encoding: "utf-8", mode: 0o600 });
        try {
          await tmux("load-buffer", "-b", bufferName, tmpPath);
          await tmux("paste-buffer", "-b", bufferName, "-t", handle.id, "-d");
        } finally {
          try {
            unlinkSync(tmpPath);
          } catch {
            // ignore cleanup errors
          }
          try {
            await tmux("delete-buffer", "-b", bufferName);
          } catch {
            // Buffer may already be deleted by -d flag
          }
        }
      } else {
        // Use -l (literal) so text like "Enter" or "Space" isn't interpreted
        // as tmux key names
        await tmux("send-keys", "-t", handle.id, "-l", message);
      }

      // Small delay to let tmux process the pasted text before pressing Enter.
      await sleep(300);
      await tmux("send-keys", "-t", handle.id, "Enter");
    },

    async getOutput(handle: RuntimeHandle, lines = 50): Promise<string> {
      try {
        return await tmux("capture-pane", "-t", handle.id, "-p", "-S", `-${lines}`);
      } catch {
        return "";
      }
    },

    async isAlive(handle: RuntimeHandle): Promise<boolean> {
      try {
        await tmux("has-session", "-t", handle.id);
        return true;
      } catch {
        return false;
      }
    },

    async getAttachInfo(handle: RuntimeHandle): Promise<AttachInfo> {
      return {
        type: "tmux",
        target: handle.id,
        command: `${TMUX_BIN} attach -t ${handle.id}`,
      };
    },
  };
}

export default { manifest, create } satisfies PluginModule<Runtime>;
