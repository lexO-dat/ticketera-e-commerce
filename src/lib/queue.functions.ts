import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Fila virtual (mockup): la posición se persiste al entrar y se descuenta con el
 * tiempo transcurrido. Cuando llega a cero se abre una ventana de compra real
 * con expiración según la configuración del evento.
 */
const DRAIN_SECONDS = 45;

const schema = z.object({
  eventId: z.string().uuid(),
  sessionToken: z.string().min(6).max(80),
});

type QueueView = {
  state: "waiting" | "active" | "expired";
  position: number;
  ahead: number;
  totalInQueue: number;
  etaSeconds: number;
  expiresAt: string | null;
  windowMinutes: number;
  message: string | null;
};

export const joinQueue = createServerFn({ method: "POST" })
  .validator((input: unknown) => schema.parse(input))
  .handler(async ({ data }): Promise<QueueView> => {
    const { adminDb } = await import("./db.server");
    const db = await adminDb();

    const { data: config } = await db
      .from("queue_config")
      .select("enabled, concurrent_slots, window_minutes, waiting_message, simulated_queue_size")
      .eq("event_id", data.eventId)
      .maybeSingle();

    const windowMinutes = config?.window_minutes ?? 10;
    const message = config?.waiting_message ?? null;

    if (!config?.enabled) {
      const expiresAt = await ensureOpenWindow(data.eventId, data.sessionToken, windowMinutes);
      return {
        state: "active",
        position: 0,
        ahead: 0,
        totalInQueue: 0,
        etaSeconds: 0,
        expiresAt,
        windowMinutes,
        message,
      };
    }

    const { data: existing } = await db
      .from("queue_sessions")
      .select("id, position, state, entered_at, expires_at")
      .eq("event_id", data.eventId)
      .eq("session_token", data.sessionToken)
      .maybeSingle();

    if (!existing) {
      const total = Math.max(20, config.simulated_queue_size);
      const position = 40 + Math.floor(Math.random() * Math.min(600, total));
      await db.from("queue_sessions").insert({
        event_id: data.eventId,
        session_token: data.sessionToken,
        position,
        state: "waiting",
      });
    }

    return readQueue(data.eventId, data.sessionToken);
  });

export const queueStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) => schema.parse(input))
  .handler(async ({ data }) => readQueue(data.eventId, data.sessionToken));

async function readQueue(eventId: string, sessionToken: string): Promise<QueueView> {
  const { adminDb } = await import("./db.server");
  const db = await adminDb();

  const { data: config } = await db
    .from("queue_config")
    .select("enabled, concurrent_slots, window_minutes, waiting_message, simulated_queue_size")
    .eq("event_id", eventId)
    .maybeSingle();

  const windowMinutes = config?.window_minutes ?? 10;
  const message = config?.waiting_message ?? null;

  const { data: session } = await db
    .from("queue_sessions")
    .select("id, position, state, entered_at, activated_at, expires_at")
    .eq("event_id", eventId)
    .eq("session_token", sessionToken)
    .maybeSingle();

  if (!config?.enabled || !session) {
    const expiresAt = await ensureOpenWindow(eventId, sessionToken, windowMinutes);
    return {
      state: "active",
      position: 0,
      ahead: 0,
      totalInQueue: 0,
      etaSeconds: 0,
      expiresAt,
      windowMinutes,
      message,
    };
  }

  const total = Math.max(session.position, config.simulated_queue_size);

  if (session.state === "active" && session.expires_at) {
    const expired = new Date(session.expires_at).getTime() < Date.now();
    if (expired) {
      await db.from("queue_sessions").update({ state: "expired" }).eq("id", session.id);
      return {
        state: "expired",
        position: 0,
        ahead: 0,
        totalInQueue: total,
        etaSeconds: 0,
        expiresAt: session.expires_at,
        windowMinutes,
        message,
      };
    }
    return {
      state: "active",
      position: 0,
      ahead: 0,
      totalInQueue: total,
      etaSeconds: 0,
      expiresAt: session.expires_at,
      windowMinutes,
      message,
    };
  }

  if (session.state === "expired") {
    return {
      state: "expired",
      position: 0,
      ahead: 0,
      totalInQueue: total,
      etaSeconds: 0,
      expiresAt: session.expires_at,
      windowMinutes,
      message,
    };
  }

  const elapsed = (Date.now() - new Date(session.entered_at).getTime()) / 1000;
  const progress = Math.min(1, elapsed / DRAIN_SECONDS);
  const ahead = Math.max(0, Math.ceil(session.position * (1 - progress)));

  if (ahead === 0) {
    const expiresAt = new Date(Date.now() + windowMinutes * 60_000).toISOString();
    await db
      .from("queue_sessions")
      .update({ state: "active", activated_at: new Date().toISOString(), expires_at: expiresAt })
      .eq("id", session.id);
    return {
      state: "active",
      position: 0,
      ahead: 0,
      totalInQueue: total,
      etaSeconds: 0,
      expiresAt,
      windowMinutes,
      message,
    };
  }

  return {
    state: "waiting",
    position: session.position,
    ahead,
    totalInQueue: total,
    etaSeconds: Math.ceil(DRAIN_SECONDS * (1 - progress)),
    expiresAt: null,
    windowMinutes,
    message,
  };
}

/**
 * Sin fila virtual (o sin sesión en fila) igual se persiste una ventana de compra
 * estable por sesión, para que el contador no se reinicie en cada poll.
 */
async function ensureOpenWindow(
  eventId: string,
  sessionToken: string,
  windowMinutes: number,
): Promise<string> {
  const { adminDb } = await import("./db.server");
  const db = await adminDb();

  const { data: existing } = await db
    .from("queue_sessions")
    .select("id, expires_at")
    .eq("event_id", eventId)
    .eq("session_token", sessionToken)
    .maybeSingle();

  const now = Date.now();
  if (existing?.expires_at && new Date(existing.expires_at).getTime() > now) {
    return existing.expires_at;
  }

  const expiresAt = new Date(now + windowMinutes * 60_000).toISOString();
  if (existing) {
    await db
      .from("queue_sessions")
      .update({ state: "active", activated_at: new Date(now).toISOString(), expires_at: expiresAt })
      .eq("id", existing.id);
  } else {
    await db.from("queue_sessions").insert({
      event_id: eventId,
      session_token: sessionToken,
      position: 0,
      state: "active",
      activated_at: new Date(now).toISOString(),
      expires_at: expiresAt,
    });
  }
  return expiresAt;
}
