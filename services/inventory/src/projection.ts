import type { Queryable } from "@shared/commons/db";
import type { CatalogClient, CatalogEvent } from "./catalog-client.js";

/**
 * Proyección local del catálogo (capacidad publicada por tipo de entrada, estado del evento y si
 * tiene fila). Se mantiene con `EventoActualizado` / `EventoEliminado` y, si falta (p. ej. el
 * evento se publicó antes de que existiera este servicio), se completa leyendo catalog.
 */
export interface ProjectedEvent {
  eventId: string;
  status: string;
  queueEnabled: boolean;
  dates: {
    dateId: string;
    startsAt: string;
    onSale: boolean;
    ticketTypes: { ticketTypeId: string; sectionId: string; seated: boolean; capacity: number }[];
  }[];
}

export function fromCatalogEvent(event: CatalogEvent): ProjectedEvent {
  return {
    eventId: event.id,
    status: event.status,
    queueEnabled: event.queue.enabled,
    dates: event.dates.map((date) => ({
      dateId: date.id,
      startsAt: date.startsAt,
      onSale: date.onSale,
      ticketTypes: date.ticketTypes.map((type) => ({
        ticketTypeId: type.id,
        sectionId: type.sectionId,
        seated: type.sectionKind === "seated",
        capacity: type.capacity,
      })),
    })),
  };
}

/**
 * Aplica el estado completo de un evento. Conserva vendidos y reservados; los tipos de entrada que
 * ya no vienen quedan inactivos. Ignora estados más viejos que el ya aplicado.
 */
export async function applyEvent(
  db: Queryable,
  event: ProjectedEvent,
  occurredAt: Date,
): Promise<boolean> {
  const upsert = await db.query(
    `insert into event_projection (event_id, status, queue_enabled, source_occurred_at)
     values ($1, $2, $3, $4)
     on conflict (event_id) do update set status = excluded.status,
       queue_enabled = excluded.queue_enabled, source_occurred_at = excluded.source_occurred_at,
       synced_at = now()
     where event_projection.source_occurred_at <= excluded.source_occurred_at`,
    [event.eventId, event.status, event.queueEnabled, occurredAt],
  );
  if (upsert.rowCount === 0) return false;

  const types = event.dates.flatMap((date) =>
    date.ticketTypes.map((type) => ({
      ticket_type_id: type.ticketTypeId,
      event_date_id: date.dateId,
      section_id: type.sectionId,
      seated: type.seated,
      capacity: type.capacity,
      on_sale: date.onSale,
      starts_at: date.startsAt,
    })),
  );
  await db.query(
    `insert into ticket_inventory
       (ticket_type_id, event_id, event_date_id, section_id, seated, capacity, on_sale, starts_at)
     select t.ticket_type_id, $1, t.event_date_id, t.section_id, t.seated, t.capacity, t.on_sale,
            t.starts_at
     from jsonb_to_recordset($2::jsonb) as t (ticket_type_id uuid, event_date_id uuid,
       section_id uuid, seated boolean, capacity int, on_sale boolean, starts_at timestamptz)
     on conflict (ticket_type_id) do update set event_date_id = excluded.event_date_id,
       section_id = excluded.section_id, seated = excluded.seated, capacity = excluded.capacity,
       on_sale = excluded.on_sale, starts_at = excluded.starts_at, active = true, updated_at = now()`,
    [event.eventId, JSON.stringify(types)],
  );
  await db.query(
    `update ticket_inventory set active = false, updated_at = now()
     where event_id = $1 and not (ticket_type_id = any($2::uuid[]))`,
    [event.eventId, types.map((type) => type.ticket_type_id)],
  );
  return true;
}

export async function applyEventRemoved(db: Queryable, eventId: string, occurredAt: Date) {
  await db.query(
    `update event_projection set status = 'deleted', source_occurred_at = $2, synced_at = now()
     where event_id = $1 and source_occurred_at <= $2`,
    [eventId, occurredAt],
  );
  await db.query("update ticket_inventory set active = false where event_id = $1", [eventId]);
}

/** Asegura que el evento esté proyectado (lee catalog si no lo está). */
export async function ensureEvent(
  db: Queryable,
  catalog: CatalogClient,
  eventId: string,
): Promise<boolean> {
  const known = await db.query("select 1 from event_projection where event_id = $1", [eventId]);
  if ((known.rowCount ?? 0) > 0) return true;
  const event = await catalog.eventById(eventId);
  if (!event) return false;
  // occurredAt "antiguo": cualquier evento real de catalog que llegue después lo reemplaza.
  await applyEvent(db, fromCatalogEvent(event), new Date(0));
  return true;
}
