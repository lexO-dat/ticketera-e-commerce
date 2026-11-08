import type { ServiceClient } from "@shared/commons/http";
import type { SeatLabels } from "./service.js";

/** Etiqueta legible de cada butaca ("Fila B · Butaca 7") desde el plano público de catalog. */
export function catalogSeatLabels(client: ServiceClient): SeatLabels {
  return {
    async labels(eventDateId, seatIds) {
      const response = await client.request<{
        seats: { id: string; row: string; number: number }[];
      }>("GET", `/v1/dates/${eventDateId}/seat-map`);
      const wanted = new Set(seatIds);
      return new Map(
        response.body.seats
          .filter((seat) => wanted.has(seat.id))
          .map((seat) => [seat.id, `Fila ${seat.row} · Butaca ${seat.number}`]),
      );
    },
  };
}
