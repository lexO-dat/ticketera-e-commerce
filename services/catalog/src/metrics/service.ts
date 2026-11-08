import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@shared/commons";
import { type Pool, type Queryable, markProcessed, withTransaction } from "@shared/commons/db";
import { type Redis, withLock } from "@shared/commons/redis";
import { type Actor, isAdmin } from "../shared.js";

export const METRIC_KINDS = ["view", "add_to_cart", "checkout", "purchase"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/** Zona horaria con que se agrupan las métricas por día. */
const TIME_ZONE = "America/Santiago";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROTATE_SCRIPT = `
if redis.call('exists', KEYS[1]) == 1 then
  redis.call('rename', KEYS[1], ARGV[1])
  redis.call('sadd', KEYS[2], ARGV[1])
end
return redis.call('smembers', KEYS[2])`;
const CONSUMER = "catalog.metrics-events";

export const METRICS_SUBSCRIPTION = {
  queue: CONSUMER,
  bindings: ["inventory.ReservaCreada.*", "orders.OrdenCreada.*", "orders.OrdenConfirmada.*"],
};

interface Row {
  eventId: string;
  kind: MetricKind;
  quantity: number;
  amount: bigint;
}

/** Suma filas al agregado diario (contador atómico en la BD, sin leer-modificar-escribir). */
async function addRows(db: Queryable, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  // El join con `events` descarta ids inexistentes (las vistas llegan de un endpoint público).
  await db.query(
    `insert into event_metrics (event_id, day, kind, quantity, amount)
     select t.event_id, (now() at time zone '${TIME_ZONE}')::date, t.kind, sum(t.quantity), sum(t.amount)
       from unnest($1::uuid[], $2::text[], $3::bigint[], $4::bigint[])
            as t(event_id, kind, quantity, amount)
       join events e on e.id = t.event_id
      group by t.event_id, t.kind
     on conflict (event_id, day, kind) do update
       set quantity = event_metrics.quantity + excluded.quantity,
           amount = event_metrics.amount + excluded.amount`,
    [
      rows.map((row) => row.eventId),
      rows.map((row) => row.kind),
      rows.map((row) => row.quantity),
      rows.map((row) => row.amount.toString()),
    ],
  );
}

export interface MetricsSummary {
  from: string;
  funnel: Record<MetricKind, number>;
  events: {
    eventId: string;
    views: number;
    addToCart: number;
    checkouts: number;
    purchases: number;
    revenue: string;
  }[];
  daily: { date: string; views: number; purchases: number; revenue: string }[];
}

export function createMetricsService(deps: {
  pool: Pool;
  redis?: Redis | undefined;
  /** Prefijo de las claves de Redis (los tests usan uno propio). */
  keyPrefix?: string;
}) {
  const { pool, redis } = deps;
  const prefix = deps.keyPrefix ?? "catalog:metrics";
  const VIEWS_KEY = `${prefix}:views`;
  const PENDING_KEY = `${prefix}:views:pending`;
  const BATCH_PREFIX = `${prefix}:views:batch:`;
  const FLUSH_LOCK = `${prefix}:flush-lock`;

  return {
    /**
     * Una vista de la página de un evento. En los peaks no se escribe a la BD por cada vista:
     * se acumula en Redis (HINCRBY) y un job la vuelca en lotes. Sin Redis, directo a la BD.
     */
    async recordView(eventId: string): Promise<void> {
      if (redis) {
        await redis.hincrby(VIEWS_KEY, eventId, 1);
        return;
      }
      await addRows(pool, [{ eventId, kind: "view", quantity: 1, amount: 0n }]);
    },

    /**
     * Vuelca las vistas acumuladas (una réplica a la vez, con lock). El script mueve el contador a
     * un lote nuevo y lo anota en un set de pendientes de forma atómica: las vistas que llegan
     * mientras tanto caen en una clave nueva, y si el proceso muere a mitad el lote sigue en el set
     * y lo toma la siguiente pasada (al-menos-una-vez).
     */
    async flushViews(): Promise<number> {
      if (!redis) return 0;
      const flushed = await withLock(redis, FLUSH_LOCK, 30_000, async () => {
        const pending = (await redis.eval(
          ROTATE_SCRIPT,
          2,
          VIEWS_KEY,
          PENDING_KEY,
          `${BATCH_PREFIX}${randomUUID()}`,
        )) as string[];
        let total = 0;
        for (const key of pending) {
          const counts = await redis.hgetall(key);
          const rows = Object.entries(counts).map(([eventId, value]) => ({
            eventId,
            kind: "view" as const,
            quantity: Number(value),
            amount: 0n,
          }));
          await addRows(
            pool,
            rows.filter((row) => UUID.test(row.eventId)),
          );
          await redis.multi().del(key).srem(PENDING_KEY, key).exec();
          total += rows.reduce((sum, row) => sum + row.quantity, 0);
        }
        return total;
      });
      return flushed ?? 0;
    },

    /** Eventos de dominio → embudo (idempotente por inbox, misma transacción que el conteo). */
    async handleEvent(event: EventEnvelope): Promise<void> {
      await withTransaction(pool, async (client) => {
        if (!(await markProcessed(client, CONSUMER, event.id))) return;
        await addRows(client, await rowsFor(client, event));
      });
    },

    async subscribe(email: string): Promise<void> {
      await pool.query(
        "insert into newsletter_subscribers (email) values ($1) on conflict (email) do nothing",
        [email.trim().toLowerCase()],
      );
    },

    /** Resumen del embudo de los últimos `days` días; el organizador solo ve sus eventos. */
    async summary(actor: Actor, days: number): Promise<MetricsSummary> {
      const scope = isAdmin(actor) ? "" : "and e.owner_id = $2";
      const params: unknown[] = [days];
      if (!isAdmin(actor)) params.push(actor.id);
      const from = `(now() at time zone '${TIME_ZONE}')::date - ($1::int - 1)`;
      const perEvent = await pool.query<{
        event_id: string;
        kind: MetricKind;
        quantity: string;
        amount: string;
      }>(
        `select m.event_id, m.kind, sum(m.quantity)::text as quantity, sum(m.amount)::text as amount
           from event_metrics m join events e on e.id = m.event_id
          where m.day >= ${from} ${scope}
          group by m.event_id, m.kind`,
        params,
      );
      const daily = await pool.query<{
        day: string;
        kind: MetricKind;
        quantity: string;
        amount: string;
      }>(
        `select to_char(m.day, 'YYYY-MM-DD') as day, m.kind,
                sum(m.quantity)::text as quantity, sum(m.amount)::text as amount
           from event_metrics m join events e on e.id = m.event_id
          where m.day >= ${from} ${scope} and m.kind in ('view', 'purchase')
          group by m.day, m.kind order by m.day`,
        params,
      );
      const fromDate = await pool.query<{ from: string }>(
        `select to_char(${from}, 'YYYY-MM-DD') as from`,
        [days],
      );

      const funnel: Record<MetricKind, number> = {
        view: 0,
        add_to_cart: 0,
        checkout: 0,
        purchase: 0,
      };
      const events = new Map<string, MetricsSummary["events"][number]>();
      for (const row of perEvent.rows) {
        const quantity = Number(row.quantity);
        funnel[row.kind] += quantity;
        const entry = events.get(row.event_id) ?? {
          eventId: row.event_id,
          views: 0,
          addToCart: 0,
          checkouts: 0,
          purchases: 0,
          revenue: "0",
        };
        if (row.kind === "view") entry.views += quantity;
        if (row.kind === "add_to_cart") entry.addToCart += quantity;
        if (row.kind === "checkout") entry.checkouts += quantity;
        if (row.kind === "purchase") {
          entry.purchases += quantity;
          entry.revenue = (BigInt(entry.revenue) + BigInt(row.amount)).toString();
        }
        events.set(row.event_id, entry);
      }
      const byDay = new Map<string, MetricsSummary["daily"][number]>();
      for (const row of daily.rows) {
        const entry = byDay.get(row.day) ?? { date: row.day, views: 0, purchases: 0, revenue: "0" };
        if (row.kind === "view") entry.views += Number(row.quantity);
        else {
          entry.purchases += Number(row.quantity);
          entry.revenue = (BigInt(entry.revenue) + BigInt(row.amount)).toString();
        }
        byDay.set(row.day, entry);
      }
      return {
        from: fromDate.rows[0]!.from,
        funnel,
        events: [...events.values()],
        daily: [...byDay.values()],
      };
    },
  };
}

export type MetricsService = ReturnType<typeof createMetricsService>;

async function rowsFor(db: Queryable, event: EventEnvelope): Promise<Row[]> {
  const data = event.data as Record<string, unknown>;
  if (event.type === "ReservaCreada") {
    // La reserva trae el tipo de entrada; catalog sabe de qué evento es.
    const result = await db.query<{ event_id: string }>(
      `select d.event_id from ticket_types t join event_dates d on d.id = t.event_date_id
        where t.id = $1`,
      [String(data["itemId"])],
    );
    const eventId = result.rows[0]?.event_id;
    if (!eventId) return [];
    return [{ eventId, kind: "add_to_cart", quantity: Number(data["quantity"] ?? 0), amount: 0n }];
  }
  if (event.type === "OrdenCreada") {
    const eventIds = Array.isArray(data["eventIds"]) ? (data["eventIds"] as string[]) : [];
    return [...new Set(eventIds)].map((eventId) => ({
      eventId,
      kind: "checkout" as const,
      quantity: 1,
      amount: 0n,
    }));
  }
  if (event.type === "OrdenConfirmada") {
    const lines = Array.isArray(data["lines"])
      ? (data["lines"] as {
          eventId?: string | null;
          quantity: number;
          unitPrice?: string;
          unitFee?: string;
        }[])
      : [];
    const perEvent = new Map<string, Row>();
    for (const line of lines) {
      if (!line.eventId) continue;
      const row = perEvent.get(line.eventId) ?? {
        eventId: line.eventId,
        kind: "purchase" as const,
        quantity: 0,
        amount: 0n,
      };
      row.quantity += line.quantity;
      // Montos del servidor (orders), nunca del cliente: bruto por línea (sin la promo de la orden).
      row.amount +=
        (BigInt(line.unitPrice ?? "0") + BigInt(line.unitFee ?? "0")) * BigInt(line.quantity);
      perEvent.set(line.eventId, row);
    }
    return [...perEvent.values()];
  }
  return [];
}
