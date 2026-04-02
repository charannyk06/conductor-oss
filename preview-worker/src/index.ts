import Fastify from "fastify";
import { BrowserManager, resolveChromePath } from "./browser/BrowserManager.js";
import { registerAuth } from "./lib/auth.js";
import { registerCommandRoutes } from "./routes/command.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { SessionStore } from "./sessions/SessionStore.js";
import type { PreviewWorkerConfig } from "./lib/types.js";

function readIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name} value: ${raw}`);
  }
  return parsed;
}

function readConfig(): PreviewWorkerConfig {
  const apiKey = process.env.WORKER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("WORKER_API_KEY must be configured.");
  }

  return {
    port: readIntegerEnv("WORKER_PORT", 3099),
    apiKey,
    sessionTimeoutMs: readIntegerEnv("WORKER_SESSION_TIMEOUT_MS", 600_000),
    maxSessions: readIntegerEnv("WORKER_MAX_SESSIONS", 5),
    chromeCommandTimeoutMs: 30_000,
    chromePath: resolveChromePath(),
    cloudflaredBin: process.env.CLOUDFLARED_BIN?.trim() || "cloudflared",
  };
}

async function main(): Promise<void> {
  const config = readConfig();
  const app = Fastify({
    logger: true,
    bodyLimit: 256 * 1024,
  });

  const sessionStore = new SessionStore(config.sessionTimeoutMs);
  const browserManager = new BrowserManager(config, sessionStore);

  registerAuth(app, config.apiKey);
  registerHealthRoutes(app, sessionStore);
  registerSessionRoutes(app, browserManager);
  registerCommandRoutes(app, browserManager);

  const shutdown = async () => {
    await browserManager.close();
    await app.close();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await app.listen({
    host: "0.0.0.0",
    port: config.port,
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
