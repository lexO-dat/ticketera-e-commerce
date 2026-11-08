import { randomInt, randomUUID } from "node:crypto";
import { AppError, type EventEnvelope, type Logger, createEvent } from "@shared/commons";
import { type Lock, type Redis, acquireLock } from "@shared/commons/redis";
import type { EventConfigSource, QueueConfig } from "./event-config.js";
import { ADMIT, FINISH, JOIN, OPEN, RETIRE } from "./scripts.js";
import type { AdmissionSigner } from "./tokens.js";

export type TurnState =
  | "NOT_REQUIRED"
  | "PREQUEUE"
  | "WAITING"
  | "ADMITTED"
  | "EXPIRED"
  | "COMPLETED"
  | "LEFT"
  | "ABANDONED"
  | "NONE";

export interface TurnStatus {
  eventId: string;
  state: TurnState;
  /** 1 = el siguiente en entrar. */
  position: number | null;
  ahead: number | null;
  waiting: number;
  etaSeconds: number | null;
  opensAt: string | null;
  admissionToken: string | null;
  expiresAt: string | null;
  windowMinutes: number;
  message: string | null;
  /** Segundos sugeridos hasta la próxima consulta (también en `Retry-After`). */
  retryAfterSeconds: number | null;
}

export interface QueueStats {
  eventId: string;
  config: QueueConfig;
  waiting: number;
  prequeue: number;
  active: number;
  opened: boolean;
  paused: boolean;
  admissionRatePerSecond: number;
}

export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}

const SOURCE = "queue";
const TURN_TTL_MS = 24 * 60 * 60_000;
const EVENTS_KEY = "q:events";

const k = (eventId: string) => {
  const prefix = `q:{${eventId}}:`;
  return {
    prefix,
    seq: `${prefix}seq`,
    waiting: `${prefix}waiting`,
    prequeue: `${prefix}prequeue`,
    active: `${prefix}active`,
    opened: `${prefix}opened`,
    paused: `${prefix}paused`,
    rate: `${prefix}rate`,
    leader: `${prefix}leader`,
    turn: (userId: string) => `${prefix}turn:${userId}`,
  };
};

/** Retry-After según cercanía: los próximos consultan más seguido (con jitter en el cliente). */
export function retryAfterFor(position: number, slots: number): number {
  if (position <= Math.max(slots, 1)) return 2;
  if (position <= slots * 10) return 5;
  return 10;
}

/**
 * ETA con la tasa real de admisión (EWMA). Sin historial, supone que cada cupo se libera al
 * terminar su ventana (cota pesimista).
 */
export function estimateEta(ahead: number, ratePerSecond: number, config: QueueConfig): number {
  const fallback = config.concurrentSlots / (config.windowMinutes * 60);
  const rate = ratePerSecond > 0.01 ? ratePerSecond : fallback;
  return Math.max(1, Math.ceil((ahead + 1) / Math.max(rate, 0.001)));
}

/** Fisher–Yates con `crypto.randomInt`: el orden de la prefila no es predecible. */
export function secureShuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function redisDown(error: unknown): never {
  if (error instanceof AppError) throw error;
  // Preferimos cerrar la fila antes que admitir sin control (ADR-06).
  throw AppError.unavailable("La fila no está disponible; intenta en un momento", 5);
}

export interface QueueServiceOptions {
  redis: Redis;
  configs: EventConfigSource;
  signer: AdmissionSigner;
  publisher: EventPublisher;
  logger: Logger;
  heartbeatTimeoutSeconds: number;
  now?: () => number;
}

export function createQueueService(options: QueueServiceOptions) {
  const { redis, configs, signer, publisher, logger } = options;
  const now = options.now ?? Date.now;
  const leaders = new Map<string, Lock>();

  function publish(type: string, eventId: string, data: Record<string, unknown>) {
    // La verdad vive en Redis; los hechos al broker son para auditoría y métricas (best effort).
    publisher
      .publish(createEvent({ type, source: SOURCE, aggregateId: eventId, data }))
      .catch((error: unknown) => logger.warn({ err: error, type }, "no se pudo publicar"));
  }

  async function rate(eventId: string): Promise<number> {
    return Number((await redis.get(k(eventId).rate)) ?? "0");
  }

  async function requireQueue(eventId: string): Promise<QueueConfig> {
    const config = await configs.get(eventId);
    if (!config.published) throw AppError.notFound("El evento no existe");
    return config;
  }

  function notRequired(config: QueueConfig): TurnStatus {
    return {
      eventId: config.eventId,
      state: "NOT_REQUIRED",
      position: null,
      ahead: null,
      waiting: 0,
      etaSeconds: null,
      opensAt: null,
      admissionToken: null,
      expiresAt: null,
      windowMinutes: config.windowMinutes,
      message: null,
      retryAfterSeconds: null,
    };
  }

  async function status(userId: string, eventId: string): Promise<TurnStatus> {
    const config = await requireQueue(eventId);
    if (!config.enabled) return notRequired(config);
    const keys = k(eventId);
    const turnKey = keys.turn(userId);
    const [turn, waitingCount] = await Promise.all([
      redis.hgetall(turnKey),
      redis.zcard(keys.waiting),
    ]);
    const base: TurnStatus = {
      ...notRequired(config),
      state: "NONE",
      waiting: waitingCount,
      opensAt: config.opensAt ? new Date(config.opensAt).toISOString() : null,
      message: config.waitingMessage,
    };
    const state = turn["state"] as TurnState | undefined;
    if (!state) return base;
    if (state === "WAITING" || state === "PREQUEUE" || state === "ADMITTED") {
      // Heartbeat: quien deja de consultar pierde su turno al llegar al frente (ABANDONED).
      await redis.hset(turnKey, "lastSeen", String(now()));
    }

    if (state === "PREQUEUE") {
      const wait = config.opensAt ? Math.max(1, Math.ceil((config.opensAt - now()) / 1000)) : 2;
      return { ...base, state, retryAfterSeconds: Math.min(10, wait) };
    }
    if (state === "WAITING") {
      const rank = await redis.zrank(keys.waiting, userId);
      if (rank === null) return { ...base, state, retryAfterSeconds: 2 };
      const ahead = rank;
      return {
        ...base,
        state,
        position: rank + 1,
        ahead,
        etaSeconds: estimateEta(ahead, await rate(eventId), config),
        retryAfterSeconds: retryAfterFor(rank + 1, config.concurrentSlots),
      };
    }
    if (state === "ADMITTED") {
      const expiresAt = Number(turn["expiresAt"]);
      const jti = turn["jti"]!;
      if (expiresAt <= now()) return { ...base, state: "EXPIRED" };
      return {
        ...base,
        state,
        expiresAt: new Date(expiresAt).toISOString(),
        admissionToken: await signer.sign({ userId, eventId, jti, expiresAt }),
      };
    }
    return { ...base, state };
  }

  return {
    status: (userId: string, eventId: string) => status(userId, eventId).catch(redisDown),

    async join(userId: string, eventId: string): Promise<TurnStatus> {
      try {
        const config = await requireQueue(eventId);
        if (!config.enabled) return notRequired(config);
        const keys = k(eventId);
        const prequeuePhase = config.opensAt !== null && config.opensAt > now();
        const [created, , seq] = (await redis.eval(
          JOIN,
          6,
          keys.seq,
          keys.waiting,
          keys.prequeue,
          keys.turn(userId),
          keys.opened,
          EVENTS_KEY,
          userId,
          String(now()),
          prequeuePhase ? "1" : "0",
          eventId,
          String(TURN_TTL_MS),
        )) as [number, string, string];
        if (created === 1)
          publish("TurnoCreado", eventId, { eventId, userId, arrival: Number(seq) });
        return await status(userId, eventId);
      } catch (error) {
        return redisDown(error);
      }
    },

    async leave(userId: string, eventId: string): Promise<void> {
      await finish(userId, eventId, "LEFT").catch(redisDown);
    },

    /** El comprador terminó (o desistió) estando admitido: libera el cupo al instante. */
    async complete(userId: string, eventId: string): Promise<boolean> {
      const jti = await finish(userId, eventId, "COMPLETED").catch(redisDown);
      if (jti) publish("TurnoCompletado", eventId, { eventId, userId, jti });
      return jti !== null;
    },

    async stats(eventId: string): Promise<QueueStats> {
      const keys = k(eventId);
      const [config, waiting, prequeue, active, opened, paused, admissionRate] = await Promise.all([
        configs.get(eventId),
        redis.zcard(keys.waiting),
        redis.scard(keys.prequeue),
        redis.zcount(keys.active, now(), "+inf"),
        redis.exists(keys.opened),
        redis.exists(keys.paused),
        rate(eventId),
      ]).catch(redisDown);
      return {
        eventId,
        config,
        waiting,
        prequeue,
        active,
        opened: opened === 1,
        paused: paused === 1,
        admissionRatePerSecond: Math.round(admissionRate * 100) / 100,
      };
    },

    async setPaused(eventId: string, paused: boolean): Promise<void> {
      const keys = k(eventId);
      await (paused ? redis.set(keys.paused, "1") : redis.del(keys.paused)).catch(redisDown);
    },

    /** Vacía la fila del evento (todos los turnos y admisiones vigentes). */
    async reset(eventId: string): Promise<number> {
      const keys = k(eventId);
      let removed = 0;
      let cursor = "0";
      do {
        const [next, batch] = await redis.scan(cursor, "MATCH", `${keys.prefix}*`, "COUNT", 500);
        cursor = next;
        const deletable = batch.filter((key) => !key.endsWith(":config"));
        if (deletable.length > 0) removed += await redis.del(...deletable);
      } while (cursor !== "0");
      await redis.srem(EVENTS_KEY, eventId);
      return removed;
    },

    /**
     * Un tick del admisor para todos los eventos con fila. Corre en todas las réplicas; por evento
     * solo actúa la que tiene el lock de líder.
     */
    async tick(): Promise<void> {
      const eventIds = await redis.smembers(EVENTS_KEY);
      for (const eventId of eventIds) {
        try {
          await tickEvent(eventId);
        } catch (error) {
          logger.warn({ err: error, eventId }, "admisor: tick falló");
        }
      }
    },

    async stop(): Promise<void> {
      await Promise.all([...leaders.values()].map((lock) => lock.release().catch(() => false)));
      leaders.clear();
    },
  };

  async function finish(userId: string, eventId: string, final: "LEFT" | "COMPLETED") {
    const keys = k(eventId);
    const [, jti] = (await redis.eval(
      FINISH,
      4,
      keys.waiting,
      keys.prequeue,
      keys.active,
      keys.turn(userId),
      userId,
      String(now()),
      keys.prefix,
      final,
    )) as [string | null, string | null];
    return jti ?? null;
  }

  async function leadership(eventId: string): Promise<boolean> {
    const current = leaders.get(eventId);
    if (current && (await current.extend(3_000))) return true;
    leaders.delete(eventId);
    const lock = await acquireLock(redis, k(eventId).leader, 3_000);
    if (!lock) return false;
    leaders.set(eventId, lock);
    return true;
  }

  async function tickEvent(eventId: string): Promise<void> {
    const keys = k(eventId);
    const config = await configs.get(eventId);
    if (!config.enabled) return;
    if (!(await leadership(eventId))) return;

    const at = now();
    if (config.opensAt !== null && config.opensAt > at) return; // prefila: aún no abre
    if (!(await redis.exists(keys.opened))) {
      const members = secureShuffle(await redis.smembers(keys.prequeue));
      const moved = (await redis.eval(
        OPEN,
        3,
        keys.opened,
        keys.prequeue,
        keys.waiting,
        String(at),
        keys.prefix,
        ...members,
      )) as number;
      if (moved > 0) logger.info({ eventId, moved }, "fila abierta: prefila aleatorizada");
    }

    const jtis = Array.from({ length: Math.max(0, config.admitBatchMax) }, () => randomUUID());
    const [expired, admitted, abandoned] = (await redis.eval(
      ADMIT,
      3,
      keys.waiting,
      keys.active,
      keys.paused,
      String(at),
      String(config.concurrentSlots),
      String(config.admitBatchMax),
      String(config.windowMinutes * 60_000),
      String(at - options.heartbeatTimeoutSeconds * 1000),
      keys.prefix,
      ...jtis,
    )) as [string[], string[], number];

    for (let i = 0; i < expired.length; i += 2) {
      publish("TurnoVencido", eventId, { eventId, userId: expired[i], jti: expired[i + 1] });
    }
    for (let i = 0; i < admitted.length; i += 3) {
      publish("TurnoAdmitido", eventId, {
        eventId,
        userId: admitted[i],
        jti: admitted[i + 1],
        expiresAt: new Date(Number(admitted[i + 2])).toISOString(),
      });
    }
    // EWMA de admisiones por segundo (base de la ETA).
    const previous = await rate(eventId);
    const next = previous * 0.8 + (admitted.length / 3) * 0.2;
    await redis.set(keys.rate, next.toFixed(4), "EX", 3600);
    if (abandoned > 0) logger.info({ eventId, abandoned }, "turnos abandonados descartados");

    // Sin nadie esperando ni admitido: el evento sale del ciclo del admisor.
    await redis.eval(RETIRE, 4, keys.waiting, keys.prequeue, keys.active, EVENTS_KEY, eventId);
  }
}

export type QueueService = ReturnType<typeof createQueueService>;
