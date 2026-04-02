import type { FastifyInstance } from "fastify";
import { SessionStore } from "../sessions/SessionStore.js";

export function registerHealthRoutes(app: FastifyInstance, sessionStore: SessionStore): void {
  app.get("/health", async () => {
    return {
      ok: true,
      sessions: sessionStore.count(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  });
}
