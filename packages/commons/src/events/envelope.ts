import { z } from "zod";
import { newId } from "../ids.js";

/**
 * Sobre común de todo evento de dominio (AsyncAPI en `packages/contracts`).
 * `id` es único y estable: los consumidores lo usan para deduplicar (idempotencia).
 */
export const eventEnvelopeSchema = z.object({
  id: z.uuid(),
  /** Nombre del evento en el lenguaje del dominio, p. ej. `OrdenConfirmada`. */
  type: z.string().regex(/^[A-Z][A-Za-z]+$/),
  /** Versión del esquema de `data`; un cambio incompatible sube la versión. */
  version: z.number().int().positive(),
  /** Servicio que lo emite, p. ej. `orders`. */
  source: z.string().regex(/^[a-z][a-z0-9-]*$/),
  occurredAt: z.iso.datetime({ offset: true }),
  /** Agregado al que pertenece (id de orden, pago, turno...). */
  aggregateId: z.string().min(1),
  correlationId: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

export type EventEnvelope<TData extends Record<string, unknown> = Record<string, unknown>> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  "data"
> & { data: TData };

export interface NewEvent<TData extends Record<string, unknown>> {
  type: string;
  version?: number;
  source: string;
  aggregateId: string;
  correlationId?: string | undefined;
  data: TData;
  occurredAt?: Date;
}

export function createEvent<TData extends Record<string, unknown>>(
  event: NewEvent<TData>,
): EventEnvelope<TData> {
  const envelope: EventEnvelope<TData> = {
    id: newId(),
    type: event.type,
    version: event.version ?? 1,
    source: event.source,
    occurredAt: (event.occurredAt ?? new Date()).toISOString(),
    aggregateId: event.aggregateId,
    data: event.data,
  };
  if (event.correlationId) envelope.correlationId = event.correlationId;
  return envelope;
}

/** Clave de enrutamiento en el exchange de tópicos: `<source>.<Type>.v<version>`. */
export function routingKeyFor(
  envelope: Pick<EventEnvelope, "source" | "type" | "version">,
): string {
  return `${envelope.source}.${envelope.type}.v${envelope.version}`;
}

export function parseEvent(raw: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(raw);
}
