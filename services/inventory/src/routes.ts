import { AppError } from "@shared/commons";
import { ADMISSION_HEADER, type AdmissionVerifier, type AuthGuards } from "@shared/commons/auth";
import { parseInput } from "@shared/commons/http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MicroCache } from "./micro-cache.js";
import type { ReservationService } from "./reservations.js";

const schemas = {
  reserve: z
    .strictObject({
      ticketTypeId: z.guid(),
      quantity: z.int().min(1).max(8).optional(),
      seatIds: z.array(z.guid()).min(1).max(8).optional(),
    })
    .refine((body) => Boolean(body.quantity) !== Boolean(body.seatIds), {
      message: "Indica quantity (sector general) o seatIds (sector numerado)",
      path: ["quantity"],
    }),
  id: z.object({ id: z.guid() }),
  eventId: z.object({ eventId: z.guid() }),
  dateId: z.object({ dateId: z.guid() }),
  mine: z.object({ eventDateId: z.guid().optional() }),
};

function userId(request: FastifyRequest): string {
  if (!request.user) throw AppError.unauthenticated();
  return request.user.id;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: {
    reservations: ReservationService;
    guards: AuthGuards;
    verifyAdmission: AdmissionVerifier;
    cache: MicroCache;
  },
): void {
  const { reservations, guards, verifyAdmission, cache } = deps;
  const user = { preHandler: guards.required() };
  const admin = { preHandler: guards.required("admin") };

  app.addHook("onSend", async (request, reply) => {
    if (request.url.startsWith("/v1/reservations") || request.url.startsWith("/v1/admin")) {
      reply.header("cache-control", "no-store");
    }
  });

  // ---------- Disponibilidad pública (micro-caché ~1 s) ----------

  app.get("/v1/availability/events/:eventId", async (request, reply) => {
    const { eventId } = parseInput(schemas.eventId, request.params);
    const items = await cache.get(`event:${eventId}`, () => reservations.availability(eventId));
    if (!items) throw AppError.notFound("El evento no existe");
    reply.header("cache-control", "public, max-age=1");
    return { eventId, items };
  });

  app.get("/v1/availability/dates/:dateId/seats", async (request, reply) => {
    const { dateId } = parseInput(schemas.dateId, request.params);
    const taken = await cache.get(`seats:${dateId}`, () => reservations.takenSeats(dateId));
    reply.header("cache-control", "public, max-age=1");
    return { eventDateId: dateId, unavailableSeatIds: taken };
  });

  // ---------- Reservas (usuario autenticado; con fila: X-Admission-Token) ----------

  app.post("/v1/reservations", user, async (request, reply) => {
    const body = parseInput(schemas.reserve, request.body);
    const header = request.headers[ADMISSION_HEADER];
    const admission =
      typeof header === "string" && header ? await verifyAdmission(header) : undefined;
    const reservation = await reservations.reserve(userId(request), body, admission, request.id);
    await cache.invalidate(`event:${reservation.eventId}`, `seats:${reservation.eventDateId}`);
    return reply.status(201).send(reservation);
  });

  app.get("/v1/reservations", user, async (request) => {
    const query = parseInput(schemas.mine, request.query);
    return { items: await reservations.mine(userId(request), query.eventDateId) };
  });

  app.get("/v1/reservations/:id", user, async (request) => {
    const { id } = parseInput(schemas.id, request.params);
    const reservation = await reservations.get(id);
    // Reemplaza RLS: solo el dueño (o admin) ve la reserva; ajena = 404.
    if (!reservation) throw AppError.notFound("La reserva no existe");
    const owner = await reservations.ownerOf(id);
    if (owner !== userId(request) && !request.user!.roles.includes("admin")) {
      throw AppError.notFound("La reserva no existe");
    }
    return reservation;
  });

  app.delete("/v1/reservations/:id", user, async (request, reply) => {
    const { id } = parseInput(schemas.id, request.params);
    const reservation = await reservations.get(id);
    await reservations.release(userId(request), id, request.id);
    if (reservation) {
      await cache.invalidate(`event:${reservation.eventId}`, `seats:${reservation.eventDateId}`);
    }
    return reply.status(204).send();
  });

  // ---------- Administración ----------

  app.get("/v1/admin/audit/events/:eventId", admin, async (request) => {
    const { eventId } = parseInput(schemas.eventId, request.params);
    return reservations.audit(eventId);
  });
}
