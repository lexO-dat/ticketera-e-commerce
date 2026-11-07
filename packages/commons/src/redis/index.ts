import { Redis, type RedisOptions } from "ioredis";
import type { Logger } from "pino";
import { randomToken } from "../ids.js";

export { Redis } from "ioredis";

export interface CreateRedisOptions {
  url: string;
  connectionName: string;
  logger?: Logger;
  options?: RedisOptions;
}

export function createRedis({ url, connectionName, logger, options }: CreateRedisOptions): Redis {
  const redis = new Redis(url, {
    connectionName,
    // Falla rápido si Redis no responde en vez de encolar comandos sin límite.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    ...options,
  });
  redis.on("error", (error) => logger?.warn({ err: error }, "redis: error"));
  return redis;
}

// Libera el lock solo si sigue siendo nuestro (otro proceso pudo tomarlo tras vencer el TTL).
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

export interface Lock {
  key: string;
  token: string;
  /** Renueva el TTL; `false` si el lock ya no nos pertenece. */
  extend(ttlMs: number): Promise<boolean>;
  release(): Promise<boolean>;
}

/**
 * Lock distribuido simple (`SET NX PX` + liberación con token) para jobs que deben correr en una
 * sola réplica: barrido de reservas, conciliación, líder del admisor de la fila.
 * Devuelve `undefined` si otro proceso tiene el lock.
 */
export async function acquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<Lock | undefined> {
  const token = randomToken(16);
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  if (ok !== "OK") return undefined;
  return {
    key,
    token,
    extend: async (nextTtlMs) => (await redis.eval(EXTEND_SCRIPT, 1, key, token, nextTtlMs)) === 1,
    release: async () => (await redis.eval(RELEASE_SCRIPT, 1, key, token)) === 1,
  };
}

/** Ejecuta `fn` si consigue el lock; si no, devuelve `undefined` sin ejecutar. */
export async function withLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  fn: (lock: Lock) => Promise<T>,
): Promise<T | undefined> {
  const lock = await acquireLock(redis, key, ttlMs);
  if (!lock) return undefined;
  try {
    return await fn(lock);
  } finally {
    await lock.release().catch(() => false);
  }
}
