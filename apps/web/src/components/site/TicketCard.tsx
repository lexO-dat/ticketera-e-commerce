import { useState } from "react";

import { GhostButton } from "@/components/kit/PillButton";
import { MetaText } from "@/components/kit/Text";
import { dateAndTime } from "@/lib/format";
import type { MyTicket } from "@/lib/tickets.functions";

export const TICKET_STATUS: Record<MyTicket["status"], string> = {
  ISSUED: "Válida",
  CHECKED_IN: "Usada",
  VOIDED: "Anulada",
};

/**
 * Entrada digital: datos del acceso y su QR firmado. Con `collapsible` el QR se muestra a pedido
 * (en la cuenta hay muchas entradas; en la orden se ve directo).
 */
export function TicketCard({
  ticket,
  collapsible = false,
}: {
  ticket: MyTicket;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const used = ticket.status === "CHECKED_IN";

  return (
    <article className="grid content-start gap-3 rounded-card bg-plaster p-5">
      {ticket.qrImage && open ? (
        <img
          src={ticket.qrImage}
          alt={`Código QR de la entrada ${ticket.code}`}
          className={`aspect-square w-full max-w-[240px] bg-white ${used ? "opacity-40" : ""}`}
        />
      ) : null}
      <span className="text-body">{ticket.name}</span>
      <MetaText>
        {ticket.startsAt ? `${dateAndTime(ticket.startsAt)} · ` : ""}
        {ticket.venueName ?? ""}
      </MetaText>
      {ticket.seatLabel ? <MetaText>{ticket.seatLabel}</MetaText> : null}
      <MetaText>
        <span className="font-roboto tracking-[0.08em]">{ticket.code}</span> ·{" "}
        {TICKET_STATUS[ticket.status]}
        {used && ticket.checkedInAt ? ` el ${dateAndTime(ticket.checkedInAt)}` : ""}
      </MetaText>
      {collapsible && ticket.qrImage ? (
        <GhostButton
          arrow={false}
          className="justify-self-start"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="underline">{open ? "Ocultar QR" : "Mostrar QR"}</span>
        </GhostButton>
      ) : null}
    </article>
  );
}
