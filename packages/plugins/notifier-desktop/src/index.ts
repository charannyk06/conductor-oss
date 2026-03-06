/**
 * notifier-desktop plugin — Desktop notifications.
 *
 * - macOS: osascript (AppleScript)
 * - Linux: notify-send (libnotify)
 * - Other platforms: silently skipped with a warning
 *
 * Title: "Conductor" + event type
 * Body: event message
 */

import { execFile } from "node:child_process";
import { platform } from "node:os";
import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  EventPriority,
} from "@conductor-oss/core";

export const manifest = {
  name: "desktop",
  slot: "notifier" as const,
  description: "Notifier plugin: desktop notifications (macOS + Linux)",
  version: "0.2.5",
};

const PLATFORM = platform();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe embedding in AppleScript double-quoted strings.
 * AppleScript uses backslash + double-quote for escaping.
 */
function escapeAppleScript(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shouldPlaySound(priority: EventPriority, soundEnabled: boolean): boolean {
  if (!soundEnabled) return false;
  return priority === "urgent";
}

function formatTitle(event: OrchestratorEvent): string {
  const prefix = event.priority === "urgent" ? "URGENT" : "Conductor";
  return `${prefix} [${event.sessionId}]`;
}

/**
 * Send a desktop notification.
 * - macOS: osascript
 * - Linux: notify-send
 */
function sendNotification(
  title: string,
  message: string,
  options: { sound: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (PLATFORM === "darwin") {
      const safeTitle = escapeAppleScript(title);
      const safeMessage = escapeAppleScript(message);
      const soundClause = options.sound ? ' sound name "default"' : "";
      const script = `display notification "${safeMessage}" with title "${safeTitle}"${soundClause}`;

      execFile("osascript", ["-e", script], (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else if (PLATFORM === "linux") {
      const args = [title, message];
      if (options.sound) {
        args.push("--urgency=critical");
      }
      execFile("notify-send", args, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      // Unsupported platform — silently skip
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin Implementation
// ---------------------------------------------------------------------------

export function create(config?: Record<string, unknown>): Notifier {
  const soundEnabled = typeof config?.sound === "boolean" ? config.sound : true;

  if (PLATFORM !== "darwin" && PLATFORM !== "linux") {
    console.warn(`[notifier-desktop] Unsupported platform "${PLATFORM}" — desktop notifications disabled.`);
    return {
      name: "desktop",
      async notify(): Promise<void> { /* noop */ },
    };
  }

  return {
    name: "desktop",

    async notify(event: OrchestratorEvent): Promise<void> {
      const title = formatTitle(event);
      const message = event.message;
      const sound = shouldPlaySound(event.priority, soundEnabled);

      try {
        await sendNotification(title, message, { sound });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[notifier-desktop] Failed to send notification: ${msg}`);
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
