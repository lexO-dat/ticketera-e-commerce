import { AppError, type Logger } from "@shared/commons";
import type { Redis } from "@shared/commons/redis";

/** Configuración de la fila de un evento (dueño: catalog; aquí se cachea, ADR-06). */
export interface QueueConfig {
  eventId: string;
  /** false también si el evento no existe o no está publicado. */
  enabled: boolean;
  published: boolean;
  opensAt: number | null;
  concurrentSlots: number;
  windowMinutes: number;
  admitBatchMax: number;
  waitingMessage: string | null;
}

export interface EventConfigSource {
  get(eventId: string): Promise<QueueConfig>;
  /** Aplica la configuración que llega en `EventoActualizado` (sin esperar al TTL). */
  apply(config: QueueConfig): Promise<void>;
}

interface CatalogEvent {
  id: string;
  status: string;
  queue: {
    enabled: boolean;
    opensAt: string | null;
    concurrentSlots: number;
    windowMinutes: number;
    admitBatchMax: number;
    waitingMessage: string | null;
  };
}

export function configFromCatalog(eventId: string, event: CatalogEvent | null): QueueConfig {
  const published = event !== null && (event.status === "published" || event.status === "soldout");
  return {
    eventId,
    enabled: published && event.queue.enabled,
    published,
    opensAt: event?.queue.opensAt ? Date.parse(event.queue.opensAt) : null,
    concurrentSlots: event?.queue.concurrentSlots ?? 0,
    windowMinutes: event?.queue.windowMinutes ?? 10,
    admitBatchMax: event?.queue.admitBatchMax ?? 50,
    waitingMessage: event?.queue.waitingMessage ?? null,
  };
}

const configKey = (eventId: string) => `q:{${eventId}}:config`;

/**
 * Lee la configuración de catalog (`GET /v1/events/by-id/:id`) con caché en Redis (TTL corto) y la
 * actualiza al instante con los eventos de catalog. Si catalog no responde y no hay copia en
 * caché, la fila no opera (503): nunca se admite sin configuración.
 */
export function createEventConfigSource(options: {
  redis: Redis;
  catalogUrl: string;
  ttlSeconds: number;
  logger: Logger;
  fetchImpl?: typeof fetch;
}): EventConfigSource {
  const { redis, catalogUrl, ttlSeconds, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function fromCatalog(eventId: string): Promise<QueueConfig> {
    let response: Response;
    try {
      response = await fetchImpl(new URL(`/v1/events/by-id/${eventId}`, catalogUrl), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(3_000),
      });
    } catch (error) {
      logger.warn({ err: error, eventId }, "catalog no responde");
      throw AppError.unavailable("La fila no está disponible; intenta en un momento", 5);
    }
    if (response.status === 404 || response.status === 400) return configFromCatalog(eventId, null);
    if (!response.ok) throw AppError.unavailable("La fila no está disponible", 5);
    return configFromCatalog(eventId, (await response.json()) as CatalogEvent);
  }

  return {
    async get(eventId) {
      const cached = await redis.get(configKey(eventId));
      if (cached) return JSON.parse(cached) as QueueConfig;
      const config = await fromCatalog(eventId);
      await redis.set(configKey(eventId), JSON.stringify(config), "EX", ttlSeconds);
      return config;
    },
    async apply(config) {
      await redis.set(configKey(config.eventId), JSON.stringify(config), "EX", ttlSeconds);
    },
  };
}
