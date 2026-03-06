/**
 * terminal-web plugin — opens browser to web terminal dashboard.
 *
 * Simple stub: openSession opens browser to localhost:3000/sessions/{id}
 * Uses `open` command on macOS.
 */

import { execFile } from "node:child_process";
import type {
  PluginModule,
  Terminal,
  Session,
} from "@conductor-oss/core";

export const manifest = {
  name: "web",
  slot: "terminal" as const,
  description: "Terminal plugin: web terminal via browser",
  version: "0.2.4",
};

export function create(config?: Record<string, unknown>): Terminal {
  const dashboardUrl = (config?.dashboardUrl as string) ?? "http://localhost:3000";

  return {
    name: "web",

    async openSession(session: Session): Promise<void> {
      const url = `${dashboardUrl}/sessions/${session.id}`;
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("open", [url], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[terminal-web] Failed to open browser: ${msg}`);
        console.log(`[terminal-web] Session ${session.id} terminal available at ${url}`);
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (sessions.length === 0) return;

      const url = `${dashboardUrl}/sessions`;
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("open", [url], (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[terminal-web] Failed to open browser: ${msg}`);
        console.log(`[terminal-web] ${sessions.length} sessions available at ${url}`);
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
