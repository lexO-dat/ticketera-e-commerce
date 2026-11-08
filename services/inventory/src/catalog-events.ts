import type { EventEnvelope } from "@shared/commons";
import { type Pool, markProcessed, withTransaction } from "@shared/commons/db";
import { type ProjectedEvent, applyEvent, applyEventRemoved } from "./projection.js";

const CONSUMER = "inventory.catalog-events";

/**
 * Consumidor idempotente (inbox) de los eventos de catalog: mantiene la capacidad publicada y el
 * estado de cada evento. Los eventos fuera de orden se descartan por `occurredAt`.
 */
export async function handleCatalogEvent(pool: Pool, event: EventEnvelope): Promise<void> {
  await withTransaction(pool, async (client) => {
    if (!(await markProcessed(client, CONSUMER, event.id))) return;
    const occurredAt = new Date(event.occurredAt);
    const data = event.data as {
      eventId: string;
      status: string;
      queue?: { enabled: boolean };
      dates?: ProjectedEvent["dates"];
    };
    if (event.type === "EventoEliminado") {
      await applyEventRemoved(client, data.eventId, occurredAt);
      return;
    }
    if (event.type !== "EventoActualizado") return;
    await applyEvent(
      client,
      {
        eventId: data.eventId,
        status: data.status,
        queueEnabled: data.queue?.enabled ?? false,
        dates: data.dates ?? [],
      },
      occurredAt,
    );
  });
}

export const CATALOG_SUBSCRIPTION = {
  queue: CONSUMER,
  bindings: ["catalog.EventoActualizado.*", "catalog.EventoEliminado.*"],
};
