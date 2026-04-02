import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: string;
  }
}

function unauthorized(reply: FastifyReply): void {
  void reply.code(401).send({ error: "Unauthorized" });
}

export function registerAuth(app: FastifyInstance, expectedApiKey: string): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/health")) {
      return;
    }

    const authorization = request.headers.authorization?.trim();
    if (!authorization?.startsWith("Bearer ")) {
      unauthorized(reply);
      return reply;
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token || token !== expectedApiKey) {
      unauthorized(reply);
      return reply;
    }

    request.apiKey = token;
  });
}

export function requireRequestApiKey(request: FastifyRequest): string {
  const apiKey = request.apiKey?.trim();
  if (!apiKey) {
    throw new Error("API key context is missing");
  }
  return apiKey;
}
