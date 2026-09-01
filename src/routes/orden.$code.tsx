import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { PillLink } from "@/components/kit/PillButton";
import { getOrder } from "@/lib/checkout.functions";
import { dateAndTime, money } from "@/lib/format";

export const Route = createFileRoute("/orden/$code")({
  head: () => ({
    meta: [
      { title: "Tu orden y tickets — Ticketera" },
      { name: "description", content: "Detalle de tu compra, tickets y códigos de acceso." },
      { property: "og:title", content: "Tu orden y tickets — Ticketera" },
      { property: "og:description", content: "Detalle de tu compra y tickets digitales." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: OrderPage,
});

type OrderItemRow = {
  id: string;
  quantity: number;
  unit_price: number | string;
  unit_fee: number | string;
  event_dates: {
    starts_at: string;
    events: { title: string; slug: string } | null;
    venues: { name: string; city: string } | null;
  } | null;
  ticket_types: { name: string } | null;
  venue_seats: { row_label: string; seat_number: number } | null;
};

function OrderPage() {
  const { code } = Route.useParams();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["order", code],
    queryFn: () => getOrder({ data: { code } }),
  });

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
          <MetaText className="mt-3">Revisa el código o búscalo de nuevo.</MetaText>
          <div className="mt-8">
            <PillLink to="/orden">Buscar orden</PillLink>
          </div>
        </div>
      </PublicLayout>
    );
  }

  const items = (data.order_items ?? []) as unknown as OrderItemRow[];
  const tickets = (data.tickets ?? []) as { id: string; ticket_code: string; order_item_id: string }[];

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[900px] px-5 py-12 md:px-8 md:py-16">
        <Caption className="text-graphite">Compra confirmada</Caption>
        <DisplayHeading className="mt-4">Orden {data.order_code}</DisplayHeading>
        <MetaText className="mt-4">
          Enviamos el detalle a {data.buyer_email}. Presenta el código de cada ticket en el acceso.
        </MetaText>

        <Hairline className="mt-10" />

        <div className="grid">
          {items.map((item) => {
            const itemTickets = tickets.filter((t) => t.order_item_id === item.id);
            const date = item.event_dates;
            return (
              <div key={item.id} className="grid gap-4 border-b border-ash py-8">
                <div className="grid gap-1">
                  {date?.events ? (
                    <Link
                      to="/evento/$slug"
                      params={{ slug: date.events.slug }}
                      className="text-subheading hover:opacity-60"
                    >
                      {date.events.title}
                    </Link>
                  ) : null}
                  <MetaText>
                    {date ? dateAndTime(date.starts_at) : ""} · {date?.venues?.name}
                  </MetaText>
                  <MetaText>
                    {item.ticket_types?.name}
                    {item.venue_seats
                      ? ` · Fila ${item.venue_seats.row_label}, Asiento ${item.venue_seats.seat_number}`
                      : ""}
                    {` · ${money(Number(item.unit_price) + Number(item.unit_fee))} c/u`}
                  </MetaText>
                </div>

                <div className="grid gap-2">
                  {itemTickets.map((ticket) => (
                    <div
                      key={ticket.id}
                      className="flex flex-wrap items-center justify-between gap-4 rounded-card bg-plaster px-5 py-4"
                    >
                      <span className="font-roboto text-body tracking-[0.08em]">
                        {ticket.ticket_code}
                      </span>
                      <MetaText className="inline">Ticket digital · válido para 1 acceso</MetaText>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-10 grid gap-3">
          <Row label="Tickets" value={money(Number(data.subtotal))} />
          <Row label="Cargos por servicio" value={money(Number(data.fees))} />
          {Number(data.discount) > 0 ? (
            <Row label={`Descuento ${data.promo_code ?? ""}`} value={`- ${money(Number(data.discount))}`} />
          ) : null}
          <Hairline />
          <div className="flex items-baseline justify-between">
            <span className="text-body">Total pagado</span>
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
