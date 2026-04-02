import type { FastifyInstance } from "fastify";
import { BrowserManager } from "../browser/BrowserManager.js";
import {
  PreviewWorkerError,
  parseWorkerCommandRequest,
} from "../lib/types.js";

function resolveErrorStatus(error: unknown): number {
  return error instanceof PreviewWorkerError ? error.statusCode : 500;
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal preview worker error";
}

export function registerCommandRoutes(app: FastifyInstance, browserManager: BrowserManager): void {
  app.post("/sessions/:id/command", async (request, reply) => {
    const params = request.params as { id?: string };
    if (!params.id) {
      return await reply.code(400).send({ error: "Missing preview session ID." });
    }

    const command = parseWorkerCommandRequest(request.body);
    if (!command) {
      return await reply.code(400).send({ error: "Invalid preview command payload." });
    }

    try {
      const response = await browserManager.executeCommand(params.id, command);
      return await reply.code(200).send(response);
    } catch (error) {
      return await reply.code(resolveErrorStatus(error)).send({
        kind: "error",
        message: resolveErrorMessage(error),
      });
    }
  });
}
