import type { EventEnvelope } from "@shared/commons";
import { type QueueConfig, configFromCatalog } from "./event-config.js";

interface CatalogEventData {
  eventId?: string;
  status?: string;
  queue?: {
    enabled: boolean;
    opensAt: string | null;
    concurrentSlots: number;
    windowMinutes: number;
    admitBatchMax: number;
    waitingMessage: string | null;
  };
}

/**
 * Traduce los eventos de catalog a la configuración de la fila. `EventoActualizado` trae el estado
 * completo, así que basta con aplicarlo (idempotente); un evento eliminado deja la fila apagada.
 */
export function configFromCatalogEvent(event: EventEnvelope): QueueConfig | undefined {
  const data = event.data as CatalogEventData;
  if (!data.eventId) return undefined;
  if (event.type === "EventoEliminado") return configFromCatalog(data.eventId, null);
  if (event.type !== "EventoActualizado" || !data.queue || !data.status) return undefined;
  return configFromCatalog(data.eventId, {
    id: data.eventId,
    status: data.status,
    queue: data.queue,
  });
}
