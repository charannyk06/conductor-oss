import type { FastifyInstance } from "fastify";
import { BrowserManager } from "../browser/BrowserManager.js";
import { requireRequestApiKey } from "../lib/auth.js";
import { PreviewWorkerError, parseCreatePreviewSessionRequest } from "../lib/types.js";

function resolveErrorStatus(error: unknown): number {
  return error instanceof PreviewWorkerError ? error.statusCode : 500;
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal preview worker error";
}

export function registerSessionRoutes(app: FastifyInstance, browserManager: BrowserManager): void {
  app.post("/sessions", async (request, reply) => {
    try {
      const apiKey = requireRequestApiKey(request);
      const payload = parseCreatePreviewSessionRequest(request.body);
      if (!payload) {
        return await reply.code(400).send({ error: "Invalid preview session payload." });
      }
      const session = await browserManager.createSession(apiKey, payload);
      return await reply.code(201).send({ sessionId: session.id });
    } catch (error) {
      return await reply.code(resolveErrorStatus(error)).send({ error: resolveErrorMessage(error) });
    }
  });

  app.delete("/sessions/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      return await reply.code(400).send({ error: "Missing preview session ID." });
    }

    try {
      await browserManager.destroySession(params.id);
      return await reply.code(204).send();
    } catch (error) {
      return await reply.code(resolveErrorStatus(error)).send({ error: resolveErrorMessage(error) });
    }
  });
}
