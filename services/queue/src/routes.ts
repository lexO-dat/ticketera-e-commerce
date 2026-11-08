import { AppError } from "@shared/commons";
import type { AuthGuards } from "@shared/commons/auth";
import { parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { QueueService, TurnStatus } from "./queue.js";
import type { AdmissionSigner } from "./tokens.js";

const eventParams = z.object({ eventId: z.guid() });

function userId(request: FastifyRequest): string {
  if (!request.user) throw AppError.unauthenticated();
  return request.user.id;
}

function send(reply: FastifyReply, status: TurnStatus) {
  if (status.retryAfterSeconds !== null)
    reply.header("retry-after", String(status.retryAfterSeconds));
  return status;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { queue: QueueService; signer: AdmissionSigner; guards: AuthGuards },
): void {
  const { queue, signer, guards } = deps;
  const user = { preHandler: guards.required() };
  const admin = { preHandler: guards.required("admin") };

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
  });

  app.get("/.well-known/jwks.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return signer.jwks();
  });

  app.post("/v1/events/:eventId/join", user, async (request, reply) => {
    const { eventId } = parseInput(eventParams, request.params);
    return send(reply, await queue.join(userId(request), eventId));
  });

  app.get("/v1/events/:eventId/status", user, async (request, reply) => {
    const { eventId } = parseInput(eventParams, request.params);
    return send(reply, await queue.status(userId(request), eventId));
  });

  app.post("/v1/events/:eventId/leave", user, async (request, reply) => {
    const { eventId } = parseInput(eventParams, request.params);
    await queue.leave(userId(request), eventId);
    return reply.status(204).send();
  });

  app.post("/v1/events/:eventId/complete", user, async (request, reply) => {
    const { eventId } = parseInput(eventParams, request.params);
    await queue.complete(userId(request), eventId);
    return reply.status(204).send();
  });

  app.get("/v1/admin/events/:eventId", admin, async (request) => {
    const { eventId } = parseInput(eventParams, request.params);
    return queue.stats(eventId);
  });

  app.post("/v1/admin/events/:eventId/pause", admin, async (request, reply) => {
    const { eventId } = parseInput(eventParams, request.params);
    await queue.setPaused(eventId, true);
    return reply.status(204).send();
  });

  app.post("/v1/admin/events/:eventId/resume", admin, async (request, reply) => {
    const { eventId } = parseInput(eventParams, request.params);
    await queue.setPaused(eventId, false);
    return reply.status(204).send();
  });

  app.post("/v1/admin/events/:eventId/reset", admin, async (request) => {
    const { eventId } = parseInput(eventParams, request.params);
    return { removedKeys: await queue.reset(eventId) };
  });
}
