import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAuth } from "@/lib/auth/middleware";

/**
 * Entradas del comprador (Fase 6): las emite `tickets` en forma asíncrona al confirmarse la orden.
 * El QR contiene un token firmado (EdDSA); aquí se convierte en una imagen SVG en el servidor.
 */
export type MyTicket = {
  id: string;
  code: string;
  orderCode: string;
  name: string;
  startsAt: string | null;
  venueName: string | null;
  sectionName: string | null;
  seatLabel: string | null;
  holderName: string;
  status: "ISSUED" | "CHECKED_IN" | "VOIDED";
  checkedInAt: string | null;
  /** `data:image/svg+xml` (se muestra con <img>, sin inyectar SVG en el DOM). */
  qrImage: string | null;
};

type ApiTicket = Omit<MyTicket, "qrImage"> & { qr?: string };

export const myTickets = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .validator((input: unknown) =>
    z
      .object({
        orderCode: z
          .string()
          .regex(/^TK-[0-9A-Z]{8}$/)
          .optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }): Promise<MyTicket[]> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const QRCode = (await import("qrcode")).default;
    const query = data.orderCode ? `?orderCode=${data.orderCode}` : "";
    const { items } = await gatewayFetch<{ items: ApiTicket[] }>(`/tickets/tickets${query}`, {
      accessToken: context.accessToken,
    });
    return Promise.all(
      items.map(async ({ qr, ...ticket }) => ({
        ...ticket,
        qrImage: qr
          ? `data:image/svg+xml;base64,${Buffer.from(
              await QRCode.toString(qr, { type: "svg", errorCorrectionLevel: "M", margin: 1 }),
            ).toString("base64")}`
          : null,
      })),
    );
  });
