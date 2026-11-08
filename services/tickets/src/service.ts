import { AppError, type Logger, createEvent, newId, secureCode } from "@shared/commons";
import { type Pool, type Queryable, enqueueOutbox, withTransaction } from "@shared/commons/db";
import type { TicketQr } from "./qr.js";

export type TicketStatus = "ISSUED" | "CHECKED_IN" | "VOIDED";
export type CheckinResult = "ACCEPTED" | "ALREADY_USED" | "VOIDED" | "WRONG_EVENT" | "INVALID";

export interface TicketDto {
  id: string;
  code: string;
  orderId: string;
  orderCode: string;
  holderName: string;
  eventId: string;
  eventDateId: string;
  name: string;
  startsAt: string | null;
  venueName: string | null;
  sectionName: string | null;
  seatLabel: string | null;
  status: TicketStatus;
  checkedInAt: string | null;
  issuedAt: string;
  /** Contenido del QR (token firmado); solo para el dueño. */
  qr?: string;
}

/** Línea de `OrdenConfirmada` (contrato AsyncAPI). */
export interface ConfirmedLine {
  lineId: string;
  kind: string;
  itemId: string;
  name: string;
  quantity: number;
  eventId: string | null;
  eventDateId: string | null;
  seatIds: string[];
  attributes?: Record<string, unknown>;
}

export interface ConfirmedOrder {
  orderId: string;
  orderCode: string;
  userId: string;
  buyerName: string;
  buyerEmail: string;
  lines: ConfirmedLine[];
}

export interface SeatLabels {
  labels(eventDateId: string, seatIds: string[]): Promise<Map<string, string>>;
}

interface TicketRow {
  id: string;
  code: string;
  order_id: string;
  order_code: string;
  user_id: string;
  holder_name: string;
  event_id: string;
  event_date_id: string;
  name: string;
  starts_at: Date | null;
  venue_name: string | null;
  section_name: string | null;
  seat_label: string | null;
  status: TicketStatus;
  checked_in_at: Date | null;
  issued_at: Date;
}

const SOURCE = "tickets";

function toDto(row: TicketRow): TicketDto {
  return {
    id: row.id,
    code: row.code,
    orderId: row.order_id,
    orderCode: row.order_code,
    holderName: row.holder_name,
    eventId: row.event_id,
    eventDateId: row.event_date_id,
    name: row.name,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    venueName: row.venue_name,
    sectionName: row.section_name,
    seatLabel: row.seat_label,
    status: row.status,
    checkedInAt: row.checked_in_at ? row.checked_in_at.toISOString() : null,
    issuedAt: row.issued_at.toISOString(),
  };
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export function createTicketService(options: {
  pool: Pool;
  qr: TicketQr;
  seats: SeatLabels;
  logger: Logger;
}) {
  const { pool, qr, seats, logger } = options;

  async function withQr(rows: TicketRow[]): Promise<TicketDto[]> {
    return Promise.all(
      rows.map(async (row) => ({
        ...toDto(row),
        // Una entrada anulada no muestra QR.
        ...(row.status !== "VOIDED"
          ? { qr: await qr.sign({ id: row.id, eventDateId: row.event_date_id }) }
          : {}),
      })),
    );
  }

  async function audit(
    db: Queryable,
    ticketId: string | null,
    eventDateId: string,
    result: CheckinResult,
    staffId: string,
    gate: string | null,
  ) {
    await db.query(
      "insert into checkins (ticket_id, event_date_id, result, scanned_by, gate) values ($1, $2, $3, $4, $5)",
      [ticketId, eventDateId, result, staffId, gate],
    );
  }

  return {
    /**
     * Emisión asíncrona (RF11) al confirmarse la orden: una entrada por unidad, idempotente
     * (`unique (order_line_id, unit_index)`), y `EntradasEmitidas` en el outbox en la misma
     * transacción. Los productos no generan entradas.
     */
    async issue(order: ConfirmedOrder): Promise<string[]> {
      const ticketLines = order.lines.filter(
        (line) => line.kind === "ticket_type" && line.eventDateId && line.eventId,
      );
      if (ticketLines.length === 0) return [];
      // Etiquetas de butaca desde catalog (fuera de la transacción).
      const labels = new Map<string, string>();
      for (const line of ticketLines) {
        if (line.seatIds.length === 0) continue;
        try {
          for (const [id, label] of await seats.labels(line.eventDateId!, line.seatIds))
            labels.set(id, label);
        } catch (error) {
          logger.warn(
            { err: error, orderId: order.orderId },
            "sin etiquetas de butaca; se emiten igual",
          );
        }
      }

      return withTransaction(pool, async (client) => {
        const issued: string[] = [];
        for (const line of ticketLines) {
          const attributes = line.attributes ?? {};
          for (let unit = 0; unit < line.quantity; unit++) {
            const seatId = line.seatIds[unit] ?? null;
            const inserted = await client.query<{ id: string }>(
              `insert into tickets (id, code, order_id, order_code, order_line_id, unit_index, user_id,
                 holder_name, holder_email, event_id, event_date_id, ticket_type_id, name, starts_at,
                 venue_name, section_name, seat_id, seat_label)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
               on conflict (order_line_id, unit_index) do nothing
               returning id`,
              [
                newId(),
                secureCode(12),
                order.orderId,
                order.orderCode,
                line.lineId,
                unit,
                order.userId,
                order.buyerName,
                order.buyerEmail,
                line.eventId,
                line.eventDateId,
                line.itemId,
                line.name,
                text(attributes["startsAt"]),
                text(attributes["venueName"]),
                text(attributes["sectionName"]),
                seatId,
                seatId ? (labels.get(seatId) ?? null) : null,
              ],
            );
            if (inserted.rows[0]) issued.push(inserted.rows[0].id);
          }
        }
        if (issued.length > 0) {
          await enqueueOutbox(
            client,
            createEvent({
              type: "EntradasEmitidas",
              source: SOURCE,
              aggregateId: order.orderId,
              data: {
                orderId: order.orderId,
                orderCode: order.orderCode,
                userId: order.userId,
                buyerName: order.buyerName,
                buyerEmail: order.buyerEmail,
                ticketIds: issued,
              },
            }),
          );
        }
        return issued;
      });
    },

    /** Orden reembolsada o cancelada: sus entradas dejan de servir. */
    async voidOrder(orderId: string, reason: string): Promise<number> {
      const result = await pool.query(
        `update tickets set status = 'VOIDED', voided_at = now(), void_reason = $2
         where order_id = $1 and status = 'ISSUED'`,
        [orderId, reason],
      );
      return result.rowCount ?? 0;
    },

    async listMine(userId: string, orderCode?: string): Promise<TicketDto[]> {
      const result = await pool.query<TicketRow>(
        `select * from tickets where user_id = $1 and ($2::text is null or order_code = $2)
         order by starts_at nulls last, name, seat_label nulls last, unit_index`,
        [userId, orderCode ?? null],
      );
      return withQr(result.rows);
    },

    async get(id: string): Promise<(TicketDto & { userId: string }) | undefined> {
      const result = await pool.query<TicketRow>("select * from tickets where id = $1", [id]);
      const row = result.rows[0];
      return row ? { ...(await withQr([row]))[0]!, userId: row.user_id } : undefined;
    },

    /**
     * Validación en puerta (RF15): verifica la firma del QR (o busca el código manual) y marca la
     * entrada con un solo UPDATE condicional. Dos escaneos simultáneos de la misma entrada en
     * puertas distintas → exactamente uno ACCEPTED. Cada intento queda auditado.
     */
    async checkin(
      staffId: string,
      input: {
        qr?: string | undefined;
        code?: string | undefined;
        eventDateId: string;
        gate?: string | undefined;
      },
    ): Promise<{ result: CheckinResult; ticket: TicketDto | null; checkedInAt: string | null }> {
      const gate = input.gate ?? null;
      let ticketId: string | undefined;
      if (input.qr) {
        const verified = await qr.verify(input.qr);
        if (!verified) {
          await audit(pool, null, input.eventDateId, "INVALID", staffId, gate);
          return { result: "INVALID", ticket: null, checkedInAt: null };
        }
        ticketId = verified.ticketId;
      } else if (input.code) {
        const found = await pool.query<{ id: string }>("select id from tickets where code = $1", [
          input.code.trim().toUpperCase(),
        ]);
        ticketId = found.rows[0]?.id;
      }
      if (!ticketId) {
        await audit(pool, null, input.eventDateId, "INVALID", staffId, gate);
        return { result: "INVALID", ticket: null, checkedInAt: null };
      }

      return withTransaction(pool, async (client) => {
        const marked = await client.query<TicketRow>(
          `update tickets set status = 'CHECKED_IN', checked_in_at = now(), checked_in_by = $3, gate = $4
           where id = $1 and status = 'ISSUED' and event_date_id = $2
           returning *`,
          [ticketId, input.eventDateId, staffId, gate],
        );
        const row = marked.rows[0];
        if (row) {
          await audit(client, row.id, input.eventDateId, "ACCEPTED", staffId, gate);
          await enqueueOutbox(
            client,
            createEvent({
              type: "EntradaValidada",
              source: SOURCE,
              aggregateId: row.id,
              data: {
                ticketId: row.id,
                orderId: row.order_id,
                eventDateId: row.event_date_id,
                validatedAt: row.checked_in_at!.toISOString(),
                gate,
              },
            }),
          );
          return {
            result: "ACCEPTED",
            ticket: toDto(row),
            checkedInAt: row.checked_in_at!.toISOString(),
          };
        }
        const current = await client.query<TicketRow>("select * from tickets where id = $1", [
          ticketId,
        ]);
        const ticket = current.rows[0];
        const result: CheckinResult = !ticket
          ? "INVALID"
          : ticket.event_date_id !== input.eventDateId
            ? "WRONG_EVENT"
            : ticket.status === "VOIDED"
              ? "VOIDED"
              : "ALREADY_USED";
        await audit(client, ticket ? ticket.id : null, input.eventDateId, result, staffId, gate);
        return {
          result,
          ticket: ticket ? toDto(ticket) : null,
          checkedInAt: ticket?.checked_in_at ? ticket.checked_in_at.toISOString() : null,
        };
      });
    },

    /** Conteo en vivo de una función (para la app de validación y el panel). */
    async stats(eventDateId: string) {
      const result = await pool.query<{ status: TicketStatus; n: string }>(
        "select status, count(*) as n from tickets where event_date_id = $1 group by status",
        [eventDateId],
      );
      const count = (status: TicketStatus) =>
        Number(result.rows.find((row) => row.status === status)?.n ?? 0);
      return {
        eventDateId,
        issued: count("ISSUED") + count("CHECKED_IN"),
        checkedIn: count("CHECKED_IN"),
        voided: count("VOIDED"),
      };
    },
  };
}

export type TicketService = ReturnType<typeof createTicketService>;

export function assertTicketAccess(
  ticket: { userId: string },
  user: { id: string; roles: string[] },
) {
  if (ticket.userId !== user.id && !user.roles.includes("admin"))
    throw AppError.notFound("La entrada no existe");
}
