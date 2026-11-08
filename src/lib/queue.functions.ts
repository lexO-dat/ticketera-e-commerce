import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/middleware";
import type { ApiTurnStatus } from "./queue.server";

/**
 * Fila virtual real (Fase 4): la sirve el microservicio `queue` vía gateway. El turno vive en el
 * servidor (recargar no lo pierde) y, al ser admitido, el token de admisión queda en una cookie
 * HttpOnly que usan las reservas.
 */
export type QueueView = {
  state: "waiting" | "prequeue" | "active" | "expired";
  position: number;
  ahead: number;
  totalInQueue: number;
  etaSeconds: number;
  opensAt: string | null;
  expiresAt: string | null;
  windowMinutes: number;
  message: string | null;
  /** Milisegundos hasta la próxima consulta (Retry-After del servidor). */
  pollMs: number;
};

const schema = z.object({ eventId: z.string().uuid() });

async function toView(status: ApiTurnStatus): Promise<QueueView> {
  if (status.state === "ADMITTED" && status.admissionToken && status.expiresAt) {
    const { storeAdmission } = await import("./queue.server");
    storeAdmission(status.eventId, status.admissionToken, status.expiresAt);
  }
  const state: QueueView["state"] =
    status.state === "ADMITTED" || status.state === "NOT_REQUIRED"
      ? "active"
      : status.state === "PREQUEUE"
        ? "prequeue"
        : status.state === "WAITING" || status.state === "NONE"
          ? "waiting"
          : "expired";
  return {
    state,
    position: status.position ?? 0,
    ahead: status.ahead ?? 0,
    totalInQueue: status.waiting,
    etaSeconds: status.etaSeconds ?? 0,
    opensAt: status.opensAt,
    expiresAt: status.expiresAt,
    windowMinutes: status.windowMinutes,
    message: status.message,
    pollMs: (status.retryAfterSeconds ?? 5) * 1000,
  };
}

export const joinQueue = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }): Promise<QueueView> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const status = await gatewayFetch<ApiTurnStatus>(`/queue/events/${data.eventId}/join`, {
      method: "POST",
      accessToken: context.accessToken,
    });
    return toView(status);
  });

export const queueStatus = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }): Promise<QueueView> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const status = await gatewayFetch<ApiTurnStatus>(`/queue/events/${data.eventId}/status`, {
      accessToken: context.accessToken,
    });
    return toView(status);
  });

/** Termina la ventana de compra (libera el cupo para el siguiente en la fila). */
export const completeTurn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    await gatewayFetch(`/queue/events/${data.eventId}/complete`, {
      method: "POST",
      accessToken: context.accessToken,
    });
    return { ok: true };
  });
