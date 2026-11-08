import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { PublicLayout } from "@/components/site/PublicLayout";
import { RequireAuth } from "@/components/site/RequireAuth";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { PillButton, PillLink } from "@/components/kit/PillButton";
import { ORDER_STATUS_LABELS } from "@/lib/account.functions";
import { getOrder, payOrder, type ApiOrder } from "@/lib/orders.functions";
import { myTickets, type MyTicket } from "@/lib/tickets.functions";
import { dateAndTime, money } from "@/lib/format";

/** `?pago=` lo agrega payments al volver del adquirente; el estado real se lee de la orden. */
const searchSchema = z.object({
  pago: z.enum(["aprobado", "rechazado", "anulado", "expirado", "pendiente"]).optional(),
});

export const Route = createFileRoute("/orden/$code")({
  validateSearch: (search) => searchSchema.parse(search),
  head: () => ({
    meta: [
      { title: "Tu orden — Ticketera" },
      { name: "description", content: "Estado de tu compra y detalle de la orden." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OrderRoute,
});

function OrderRoute() {
  const { code } = Route.useParams();
  return (
    <RequireAuth redirectTo={`/orden/${code}`}>
      <OrderPage />
    </RequireAuth>
  );
}

const RETURN_MESSAGES: Record<string, string> = {
  rechazado: "El pago fue rechazado. Tus entradas se liberaron; puedes intentarlo de nuevo.",
  anulado: "Anulaste el pago en Webpay. Tus entradas se liberaron.",
  expirado: "El tiempo para pagar terminó. Tus entradas se liberaron.",
};

function headline(order: ApiOrder): string {
  switch (order.status) {
    case "CONFIRMED":
      return "¡Compra confirmada!";
    case "PENDING_PAYMENT":
      return "Confirmando tu pago…";
    case "REFUND_PENDING":
    case "REFUNDED":
      return order.cancelReason === "LATE_PAYMENT"
        ? "Tu pago llegó tarde y lo devolvimos"
        : "Orden reembolsada";
    default:
      return "La compra no se completó";
  }
}

function OrderPage() {
  const { code } = Route.useParams();
  const { pago } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["order", code],
    queryFn: () => getOrder({ data: { code } }),
    // Mientras el pago se confirma (eventos asíncronos) se consulta cada 2 s.
    refetchInterval: (query) => (query.state.data?.status === "PENDING_PAYMENT" ? 2000 : false),
  });

  async function retryPayment() {
    setError(null);
    try {
      const result = await payOrder({ data: { code } });
      if (result.redirectUrl) window.location.assign(result.redirectUrl);
      else setError("El pago ya está en curso; espera unos segundos.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos abrir el pago");
    }
  }

  if (isLoading) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
          <MetaText>Buscando tu orden…</MetaText>
        </div>
      </PublicLayout>
    );
  }

  if (isError || !data) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
          <SectionTitle>No encontramos esa orden</SectionTitle>
          <MetaText className="mt-3">Revisa el código o búscala en Mi cuenta.</MetaText>
          <div className="mt-8">
            <PillLink to="/mi-cuenta">Ir a Mi cuenta</PillLink>
          </div>
        </div>
      </PublicLayout>
    );
  }

  const pendingWithoutAttempt = data.status === "PENDING_PAYMENT" && !pago;

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[900px] px-5 py-12 md:px-8 md:py-16">
        <Caption className="text-graphite">Orden {data.orderCode}</Caption>
        <DisplayHeading className="mt-4">{headline(data)}</DisplayHeading>
        <MetaText className="mt-4">
          Estado: {ORDER_STATUS_LABELS[data.status]}
          {data.status === "CONFIRMED"
            ? ` · Enviaremos el detalle a ${data.buyer.email}. Tus entradas con código QR se emiten en breve.`
            : ""}
        </MetaText>
        {pago && RETURN_MESSAGES[pago] && data.status !== "CONFIRMED" ? (
          <p role="status" className="mt-4 text-body text-ember">
            {RETURN_MESSAGES[pago]}
          </p>
        ) : null}
        {data.status === "PENDING_PAYMENT" ? (
          <div className="mt-6 grid gap-3">
            <MetaText>
              {pendingWithoutAttempt
                ? `Tus entradas están reservadas hasta las ${new Date(data.expiresAt).toLocaleTimeString("es-CL")}.`
                : "Estamos esperando la confirmación del pago. Esta página se actualiza sola."}
            </MetaText>
            {pendingWithoutAttempt ? (
              <div>
                <PillButton onClick={() => void retryPayment()}>Pagar ahora</PillButton>
              </div>
            ) : null}
            {error ? <MetaText className="text-ember">{error}</MetaText> : null}
          </div>
        ) : null}

        {data.status === "CONFIRMED" ? <OrderTickets code={data.orderCode} /> : null}

        <Hairline className="mt-10" />

        <div className="grid">
          {data.lines.map((line) => {
            const startsAt = line.attributes["startsAt"];
            const venue = line.attributes["venueName"];
            return (
              <div key={line.id} className="grid gap-1 border-b border-ash py-6">
                <span className="text-subheading">{line.name}</span>
                <MetaText>
                  {typeof startsAt === "string" ? `${dateAndTime(startsAt)} · ` : ""}
                  {typeof venue === "string" ? venue : ""}
                </MetaText>
                <MetaText>
                  {line.quantity} × {money(Number(line.unitPrice) + Number(line.unitFee))}
                  {line.seatIds.length > 0 ? ` · ${line.seatIds.length} butaca(s) numerada(s)` : ""}
                </MetaText>
              </div>
            );
          })}
        </div>

        <div className="mt-10 grid gap-3">
          <Row label="Tickets y productos" value={money(Number(data.subtotal))} />
          <Row label="Cargos por servicio" value={money(Number(data.fees))} />
          {Number(data.discount) > 0 ? (
            <Row
              label={`Descuento ${data.promoCode ?? ""}`}
              value={`- ${money(Number(data.discount))}`}
            />
          ) : null}
          <Hairline />
          <div className="flex items-baseline justify-between">
            <span className="text-body">Total</span>
            <span className="text-subheading">{money(Number(data.total))}</span>
          </div>
        </div>

        <div className="mt-12">
          <PillLink to="/eventos" search={{}}>
            Seguir explorando
          </PillLink>
        </div>
      </div>
    </PublicLayout>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <MetaText className="inline">{label}</MetaText>
      <span className="text-body">{value}</span>
    </div>
  );
}

const TICKET_STATUS: Record<MyTicket["status"], string> = {
  ISSUED: "Válida",
  CHECKED_IN: "Usada",
  VOIDED: "Anulada",
};

/** Entradas con QR (se emiten unos segundos después de confirmarse el pago). */
function OrderTickets({ code }: { code: string }) {
  const { data } = useQuery({
    queryKey: ["tickets", code],
    queryFn: () => myTickets({ data: { orderCode: code } }),
    refetchInterval: (query) => ((query.state.data?.length ?? 0) === 0 ? 1500 : false),
  });
  if (!data || data.length === 0) {
    return <MetaText className="mt-8">Emitiendo tus entradas…</MetaText>;
  }
  return (
    <section className="mt-10 grid gap-6">
      <SectionTitle>Tus entradas</SectionTitle>
      <MetaText>Presenta el QR en el acceso. Cada entrada sirve para un ingreso.</MetaText>
      <div className="grid gap-6 sm:grid-cols-2">
        {data.map((ticket) => (
          <article key={ticket.id} className="grid gap-3 rounded-card bg-plaster p-5">
            {ticket.qrImage ? (
              <img
                src={ticket.qrImage}
                alt={`Código QR de la entrada ${ticket.code}`}
                className="aspect-square w-full max-w-[220px] bg-white"
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
            </MetaText>
          </article>
        ))}
      </div>
    </section>
  );
}
