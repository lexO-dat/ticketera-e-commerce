import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/middleware";

/**
 * Reservas reales (Fase 4, ADR-03): `inventory` vía gateway. Exclusivas por 10 minutos, con
 * bloqueo pesimista en la BD; en eventos con fila se adjunta el turno (cookie HttpOnly).
 */
type ApiReservation = {
  id: string;
  status: string;
  eventDateId: string;
  ticketTypeId: string;
  quantity: number;
  seatIds: string[];
  expiresAt: string;
};

const reserveSchema = z.object({
  eventId: z.string().uuid(),
  eventDateId: z.string().uuid(),
  seated: z
    .array(
      z.object({
        ticketTypeId: z.string().uuid(),
        seatIds: z.array(z.string().uuid()).min(1).max(8),
      }),
    )
    .max(8),
  general: z
    .array(z.object({ ticketTypeId: z.string().uuid(), quantity: z.number().int().min(1).max(8) }))
    .max(8),
});

export type ReserveResult =
  | {
      ok: true;
      reservations: { id: string; ticketTypeId: string; quantity: number; seatIds: string[] }[];
      expiresAt: string;
    }
  | {
      ok: false;
      reason: "SEAT_TAKEN" | "NOT_AVAILABLE" | "ADMISSION_REQUIRED" | "LIMIT" | "OTHER";
      message: string;
      conflicts: string[];
    };

export const reserveTickets = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => reserveSchema.parse(input))
  .handler(async ({ data, context }): Promise<ReserveResult> => {
    const { gatewayFetch, GatewayError } = await import("./auth/gateway.server");
    const { readAdmission } = await import("./queue.server");
    const auth = { accessToken: context.accessToken };

    // Reemplaza la selección anterior del usuario para esta función.
    const previous = await gatewayFetch<{ items: ApiReservation[] }>(
      `/inventory/reservations?eventDateId=${data.eventDateId}`,
      auth,
    );
    await Promise.all(
      previous.items.map((item) =>
        gatewayFetch(`/inventory/reservations/${item.id}`, { method: "DELETE", ...auth }),
      ),
    );

    const admission = readAdmission(data.eventId);
    const requests = [
      ...data.seated.map((item) => ({ ticketTypeId: item.ticketTypeId, seatIds: item.seatIds })),
      ...data.general.map((item) => ({ ticketTypeId: item.ticketTypeId, quantity: item.quantity })),
    ];
    const created: ApiReservation[] = [];
    try {
      for (const body of requests) {
        created.push(
          await gatewayFetch<ApiReservation>("/inventory/reservations", {
            method: "POST",
            body,
            ...auth,
            ...(admission ? { headers: { "x-admission-token": admission } } : {}),
          }),
        );
      }
    } catch (error) {
      // Todo o nada: si una parte falla, se devuelve lo que ya se había reservado.
      await Promise.all(
        created.map((item) =>
          gatewayFetch(`/inventory/reservations/${item.id}`, { method: "DELETE", ...auth }).catch(
            () => undefined,
          ),
        ),
      );
      if (!(error instanceof GatewayError)) throw error;
      const reason =
        error.reason === "SEAT_TAKEN"
          ? "SEAT_TAKEN"
          : error.reason === "ADMISSION_REQUIRED"
            ? "ADMISSION_REQUIRED"
            : error.reason === "LIMIT_PER_USER"
              ? "LIMIT"
              : error.reason === "NOT_ENOUGH_AVAILABLE" || error.reason === "NOT_ON_SALE"
                ? "NOT_AVAILABLE"
                : "OTHER";
      return {
        ok: false,
        reason,
        message: error.message,
        conflicts: error.reason === "SEAT_TAKEN" ? error.issues.map((issue) => issue.message) : [],
      };
    }
    const expiresAt = created.map((item) => item.expiresAt).sort()[0] ?? new Date().toISOString();
    return {
      ok: true,
      reservations: created.map((item) => ({
        id: item.id,
        ticketTypeId: item.ticketTypeId,
        quantity: item.quantity,
        seatIds: item.seatIds,
      })),
      expiresAt,
    };
  });

export const releaseTickets = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => z.object({ eventDateId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const auth = { accessToken: context.accessToken };
    const mine = await gatewayFetch<{ items: ApiReservation[] }>(
      `/inventory/reservations?eventDateId=${data.eventDateId}`,
      auth,
    );
    await Promise.all(
      mine.items.map((item) =>
        gatewayFetch(`/inventory/reservations/${item.id}`, { method: "DELETE", ...auth }),
      ),
    );
    return { released: mine.items.length };
  });
