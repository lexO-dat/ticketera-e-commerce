import type { Logger } from "pino";
import { type EventEnvelope, parseEvent } from "../events/envelope.js";
import type { Pool, Queryable } from "./pool.js";

/**
 * Patrón _transactional outbox_: el evento se escribe en la misma transacción que el cambio de
 * estado y un _relay_ lo publica después. Así nunca se publica un evento de algo que hizo ROLLBACK
 * ni se pierde uno de algo que hizo COMMIT.
 *
 * Patrón _inbox_: el consumidor registra `(consumer, event_id)` en la misma transacción en que
 * aplica el efecto; si el evento llega de nuevo, se ignora (entrega al-menos-una-vez → efecto
 * exactamente-una-vez).
 *
 * Las tablas se crean con la migración `0001_outbox_inbox.sql` de la plantilla de servicio
 * (mismo SQL que `OUTBOX_INBOX_SQL`).
 */
export const OUTBOX_INBOX_SQL = `
create table if not exists outbox (
  seq bigint generated always as identity primary key,
  id uuid not null unique,
  aggregate_id text not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0,
  last_error text
);
create index if not exists outbox_pending_idx on outbox (seq) where published_at is null;

create table if not exists inbox (
  consumer text not null,
  event_id uuid not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, event_id)
);
`;

/** Encola el evento. Llamar con el `client` de la transacción que hace el cambio de estado. */
export async function enqueueOutbox(client: Queryable, event: EventEnvelope): Promise<void> {
  await client.query(
    "insert into outbox (id, aggregate_id, type, payload) values ($1, $2, $3, $4)",
    [event.id, event.aggregateId, event.type, JSON.stringify(event)],
  );
}

/**
 * Marca el evento como procesado por `consumer`. Devuelve `false` si ya se había procesado:
 * en ese caso el consumidor no debe repetir el efecto.
 */
export async function markProcessed(
  client: Queryable,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const result = await client.query(
    "insert into inbox (consumer, event_id) values ($1, $2) on conflict do nothing",
    [consumer, eventId],
  );
  return result.rowCount === 1;
}

export interface EventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}

export interface OutboxRelayOptions {
  pool: Pool;
  publisher: EventPublisher;
  logger: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
}

/**
 * Publica los eventos pendientes en orden de inserción (`seq`, también dentro de una transacción). Varias réplicas pueden correrlo a la vez:
 * `FOR UPDATE SKIP LOCKED` reparte los lotes sin publicar dos veces el mismo evento.
 * Si una publicación falla, se detiene el lote (conserva el orden) y se reintenta en el próximo ciclo.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: OutboxRelayOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** Procesa un lote. Devuelve cuántos eventos publicó. Expuesto para pruebas. */
  async publishBatch(): Promise<number> {
    const client = await this.options.pool.connect();
    let published = 0;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string; payload: unknown }>(
        `select id, payload from outbox
          where published_at is null
          order by seq
          limit $1
          for update skip locked`,
        [this.batchSize],
      );
      for (const row of rows) {
        try {
          await this.options.publisher.publish(parseEvent(row.payload));
          await client.query(
            "update outbox set published_at = now(), attempts = attempts + 1 where id = $1",
            [row.id],
          );
          published++;
        } catch (error) {
          await client.query(
            "update outbox set attempts = attempts + 1, last_error = $2 where id = $1",
            [row.id, String(error).slice(0, 500)],
          );
          this.options.logger.warn({ err: error, outboxId: row.id }, "outbox: no se pudo publicar");
          break;
        }
      }
      await client.query("COMMIT");
      return published;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let published = 0;
    try {
      published = await this.publishBatch();
    } catch (error) {
      this.options.logger.error({ err: error }, "outbox: error al leer pendientes");
    }
    // Si el lote vino lleno probablemente hay más: seguir sin esperar.
    this.schedule(published >= this.batchSize ? 0 : this.pollIntervalMs);
  }
}
