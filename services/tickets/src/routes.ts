import { AppError } from "@shared/commons";
import type { AuthGuards } from "@shared/commons/auth";
import { parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TicketQr } from "./qr.js";
import { type TicketService, assertTicketAccess } from "./service.js";

const schemas = {
  id: z.object({ id: z.guid() }),
  mine: z.object({
    orderCode: z
      .string()
      .regex(/^TK-[0-9A-Z]{8}$/)
      .optional(),
  }),
  checkin: z
    .strictObject({
      qr: z.string().max(1024).optional(),
      code: z.string().trim().max(20).optional(),
      eventDateId: z.guid(),
      gate: z.string().trim().max(40).optional(),
    })
    .refine((body) => Boolean(body.qr) !== Boolean(body.code), {
      message: "Envía el QR o el código, no ambos",
      path: ["qr"],
    }),
  dateId: z.object({ dateId: z.guid() }),
};

function userOf(request: FastifyRequest) {
  if (!request.user) throw AppError.unauthenticated();
  return request.user;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { tickets: TicketService; qr: TicketQr; guards: AuthGuards },
): void {
  const { tickets, qr, guards } = deps;
  const user = { preHandler: guards.required() };
  // Validación en puerta: personal del evento (staff) u organización.
  const door = { preHandler: guards.required("staff", "organizer", "admin") };

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/")) reply.header("cache-control", "no-store");
  });

  app.get("/.well-known/jwks.json", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return qr.jwks();
  });

  // ---------- Historial del comprador (RF12) ----------

  app.get("/v1/tickets", user, async (request) => {
    const query = parseInput(schemas.mine, request.query);
    return { items: await tickets.listMine(userOf(request).id, query.orderCode) };
  });

  app.get("/v1/tickets/:id", user, async (request) => {
    const { id } = parseInput(schemas.id, request.params);
    const ticket = await tickets.get(id);
    if (!ticket) throw AppError.notFound("La entrada no existe");
    assertTicketAccess(ticket, userOf(request));
    // El dueño no viaja en la respuesta.
    return Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "userId"));
  });

  // ---------- Validación en puerta (RF15) ----------

  app.post("/v1/checkin", door, async (request) => {
    const body = parseInput(schemas.checkin, request.body);
    return tickets.checkin(userOf(request).id, body);
  });

  app.get("/v1/checkin/dates/:dateId/stats", door, async (request) => {
    const { dateId } = parseInput(schemas.dateId, request.params);
    return tickets.stats(dateId);
  });
}
