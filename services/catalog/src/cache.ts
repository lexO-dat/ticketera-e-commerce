import type { Logger } from "@shared/commons";
import type { Redis } from "@shared/commons/redis";

/**
 * Caché de lectura del catálogo público (ADR-02).
 *
 * - Las claves llevan un número de **generación**: cada escritura lo incrementa (`invalidate`) y
 *   todas las réplicas dejan de ver las entradas anteriores al instante, sin borrar por patrón.
 *   El TTL (segundos) acota la memoria y es la red de seguridad si un INCR se pierde.
 * - Varias solicitudes simultáneas por la misma clave en una réplica comparten una sola consulta a
 *   la BD (_single flight_): protege a Postgres de la estampida al abrir una venta.
 * - Si Redis no responde, se lee directo de la BD (la caché nunca es la fuente de verdad).
 */
export interface ReadCache {
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
  /** Llamar **después** del COMMIT de una escritura. */
  invalidate(): Promise<void>;
}

export function createReadCache(options: {
  redis: Redis;
  ttlSeconds: number;
  logger: Logger;
  /** Espacio de nombres en Redis (las pruebas usan uno propio). */
  prefix?: string;
}): ReadCache {
  const { redis, ttlSeconds, logger } = options;
  const prefix = options.prefix ?? "catalog:cache:";
  const generationKey = `${prefix}gen`;
  const inFlight = new Map<string, Promise<unknown>>();

  async function loadAndStore<T>(fullKey: string, load: () => Promise<T>): Promise<T> {
    let hit: string | null = null;
    try {
      hit = await redis.get(fullKey);
    } catch (error) {
      logger.warn({ err: error, fullKey }, "caché de catálogo no disponible; se lee de la BD");
    }
    if (hit !== null) return JSON.parse(hit) as T;
    const value = await load();
    redis
      .set(fullKey, JSON.stringify(value), "EX", ttlSeconds)
      .catch((error: unknown) =>
        logger.warn({ err: error, fullKey }, "no se pudo guardar en caché"),
      );
    return value;
  }

  return {
    async get<T>(key: string, load: () => Promise<T>): Promise<T> {
      let fullKey: string;
      try {
        const generation = (await redis.get(generationKey)) ?? "0";
        fullKey = `${prefix}${generation}:${key}`;
      } catch (error) {
        logger.warn({ err: error, key }, "caché de catálogo no disponible; se lee de la BD");
        return load();
      }
      // Single flight por clave **y generación**: quien llega después de una escritura no se
      // suma a una lectura iniciada antes de ella.
      const pending = inFlight.get(fullKey);
      if (pending) return pending as Promise<T>;
      const promise = loadAndStore(fullKey, load).finally(() => inFlight.delete(fullKey));
      inFlight.set(fullKey, promise);
      return promise;
    },
    async invalidate() {
      try {
        await redis.incr(generationKey);
      } catch (error) {
        // El TTL corto deja la caché consistente en a lo más `ttlSeconds`.
        logger.warn({ err: error }, "no se pudo invalidar la caché de catálogo");
      }
    },
  };
}

/** Caché nula (pruebas o sin Redis). */
export const noCache: ReadCache = {
  get: (_key, load) => load(),
  invalidate: async () => undefined,
};
