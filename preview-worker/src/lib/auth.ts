import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: string;
  }
}

export function registerAuth(app: FastifyInstance, expectedApiKey: string): void {
  // preHandler runs after routing; if we send 401 here, the route handler is not invoked.
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.startsWith("/health")) {
      return;
    }

    const authorization = request.headers.authorization?.trim();
    if (!authorization?.startsWith("Bearer ")) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token || token !== expectedApiKey) {
      await reply.code(401).send({ error: "Unauthorized" });
      return;
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
