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

/**
 * Opciones de conexión a partir de la URL. Con `?sentinels=host:puerto,…&master=nombre` (ADR-01)
 * el cliente pregunta a los Sentinel quién es el primario y, tras un failover, se reconecta al
 * nuevo; sin esos parámetros es una conexión directa.
 */
export function redisConnectionOptions(url: string): RedisOptions {
  const parsed = new URL(url);
  const sentinels = parsed.searchParams.get("sentinels");
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  if (!sentinels) return {};
  return {
    sentinels: sentinels.split(",").map((entry) => {
      const [host, port] = entry.trim().split(":");
      return { host: host!, port: Number(port || 26379) };
    }),
    name: parsed.searchParams.get("master") ?? "ticketera",
    ...(password ? { password } : {}),
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    db: Number(parsed.pathname.slice(1) || 0),
    // Comprueba con los Sentinel que el nodo sigue siendo primario al reconectar.
    role: "master",
    failoverDetector: true,
    sentinelRetryStrategy: (times) => Math.min(times * 200, 2_000),
  };
}

export function createRedis({ url, connectionName, logger, options }: CreateRedisOptions): Redis {
  const sentinel = redisConnectionOptions(url);
  const base: RedisOptions = {
    connectionName,
    // Falla rápido si Redis no responde en vez de encolar comandos sin límite.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    connectTimeout: 1_000,
    // Un comando sin respuesta (primario caído, failover en curso) falla en vez de colgar la
    // solicitud: el gateway, por ejemplo, deja pasar el rate limit si Redis no responde.
    commandTimeout: 1_000,
    // Reintento rápido: tras un failover el primario nuevo está listo en segundos.
    retryStrategy: (times) => Math.min(times * 100, 2_000),
    ...options,
  };
  const redis = sentinel.sentinels ? new Redis({ ...base, ...sentinel }) : new Redis(url, base);
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
