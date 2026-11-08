import type { Logger } from "@shared/commons";
import type { Redis } from "@shared/commons/redis";

/**
 * Micro-caché (≈1 s) para lecturas públicas muy frecuentes, como la disponibilidad durante una
 * apertura de venta. Con _single flight_ por réplica. Si Redis falla, lee directo. La reserva
 * nunca usa esta caché: siempre decide la BD bajo bloqueo.
 */
export function createMicroCache(options: {
  redis: Redis;
  ttlMs: number;
  logger: Logger;
  prefix?: string;
}) {
  const { redis, ttlMs, logger } = options;
  const prefix = options.prefix ?? "inv:cache:";
  const inFlight = new Map<string, Promise<unknown>>();

  async function load<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    try {
      const hit = await redis.get(prefix + key);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (error) {
      logger.warn({ err: error }, "micro-caché no disponible");
    }
    const value = await fetcher();
    redis.set(prefix + key, JSON.stringify(value), "PX", ttlMs).catch(() => undefined);
    return value;
  }

  return {
    get<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
      if (ttlMs === 0) return fetcher();
      const pending = inFlight.get(key);
      if (pending) return pending as Promise<T>;
      const promise = load(key, fetcher).finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
    async invalidate(...keys: string[]) {
      if (ttlMs === 0 || keys.length === 0) return;
      await redis.del(...keys.map((key) => prefix + key)).catch(() => undefined);
    },
  };
}

export type MicroCache = ReturnType<typeof createMicroCache>;
