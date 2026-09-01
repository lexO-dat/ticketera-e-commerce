import { createFileRoute, Link } from "@tanstack/react-router";

import { PublicLayout } from "@/components/site/PublicLayout";
import { DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillLink } from "@/components/kit/PillButton";
import { removeFromCart, setQuantity, useCart } from "@/lib/cart";
import { dateAndTime, money } from "@/lib/format";

export const Route = createFileRoute("/carro")({
  head: () => ({
    meta: [
      { title: "Tu carro de compras — Ticketera" },
      { name: "description", content: "Revisa tus tickets antes de pagar." },
      { property: "og:title", content: "Tu carro de compras — Ticketera" },
      { property: "og:description", content: "Revisa tus tickets antes de pagar." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CartPage,
});

function CartPage() {
  const { items, totals } = useCart();

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-12 md:px-8 md:py-16">
        <DisplayHeading>Tu carro</DisplayHeading>

        {items.length === 0 ? (
          <div className="py-16">
            <SectionTitle>Todavía no tienes tickets</SectionTitle>
            <MetaText className="mt-3">Explora la cartelera y elige tu próximo show.</MetaText>
            <div className="mt-8">
              <PillLink to="/eventos" search={{}}>
                Ver cartelera
              </PillLink>
            </div>
          </div>
        ) : (
          <div className="mt-10 grid gap-12 lg:grid-cols-[1.6fr_1fr] lg:items-start">
            <div>
              <Hairline />
              {items.map((item) => (
                <div
                  key={item.key}
                  className="grid gap-4 border-b border-ash py-7 md:grid-cols-[1.4fr_auto_auto] md:items-center"
                >
                  <div className="grid gap-1">
                    <Link
                      to="/evento/$slug"
                      params={{ slug: item.eventSlug }}
                      className="text-subheading hover:opacity-60"
                    >
                      {item.eventTitle}
                    </Link>
                    <MetaText>
                      {dateAndTime(item.startsAt)} · {item.venueName}
                    </MetaText>
                    <MetaText>
                      {item.sectionName}
                      {item.seatLabel ? ` · ${item.seatLabel}` : ""}
                    </MetaText>
                  </div>

                  <div className="flex items-center gap-4">
                    {item.seatId ? (
                      <MetaText className="inline">1 ticket</MetaText>
                    ) : (
                      <>
                        <GhostButton
                          arrow={false}
                          aria-label="Restar"
                          onClick={() => setQuantity(item.key, item.quantity - 1)}
                        >
                          −
                        </GhostButton>
                        <span className="w-6 text-center text-body">{item.quantity}</span>
                        <GhostButton
                          arrow={false}
                          aria-label="Sumar"
                          onClick={() => setQuantity(item.key, item.quantity + 1)}
                        >
                          +
                        </GhostButton>
                      </>
                    )}
                  </div>

                  <div className="grid justify-items-end gap-2">
                    <span className="text-body">
                      {money((item.unitPrice + item.unitFee) * item.quantity)}
                    </span>
                    <GhostButton arrow={false} onClick={() => removeFromCart(item.key)}>
                      <span className="text-graphite underline">Quitar</span>
                    </GhostButton>
                  </div>
                </div>
              ))}
            </div>

            <aside className="grid gap-5 rounded-card bg-plaster p-7 lg:sticky lg:top-28">
              <SectionTitle>Resumen</SectionTitle>
              <Row label={`Tickets (${totals.count})`} value={money(totals.subtotal)} />
              <Row label="Cargos por servicio" value={money(totals.fees)} />
              <Hairline />
              <div className="flex items-baseline justify-between">
                <span className="text-body">Total</span>
                <span className="text-subheading">{money(totals.total)}</span>
              </div>
              <PillLink to="/checkout">Ir a pagar</PillLink>
              <MetaText>Tus butacas están reservadas por tiempo limitado.</MetaText>
            </aside>
          </div>
        )}
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
