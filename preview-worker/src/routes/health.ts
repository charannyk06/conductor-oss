import type { FastifyInstance } from "fastify";
import { SessionStore } from "../sessions/SessionStore.js";

export function resolveBuildSha(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CONDUCTOR_BUILD_SHA?.trim() || "unknown";
}

export function registerHealthRoutes(
  app: FastifyInstance,
  sessionStore: SessionStore,
  buildSha = resolveBuildSha(),
): void {
  app.get("/health", async () => {
    return {
      ok: true,
      buildSha,
      sessions: sessionStore.count(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });
}
