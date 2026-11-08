import { createFileRoute, Link } from "@tanstack/react-router";

import { PublicLayout } from "@/components/site/PublicLayout";
import { DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillLink } from "@/components/kit/PillButton";
import { addToCart, isProduct, removeFromCart, useCart, type CartItem } from "@/lib/cart";
import { dateAndTime, money } from "@/lib/format";

export const Route = createFileRoute("/carro")({
  head: () => ({
    meta: [
      { title: "Tu carro de compras — Ticketera" },
      { name: "description", content: "Revisa tus tickets y productos antes de pagar." },
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
            <SectionTitle>Tu carro está vacío</SectionTitle>
            <MetaText className="mt-3">
              Explora la cartelera o la tienda y elige tu próximo show.
            </MetaText>
            <div className="mt-8 flex flex-wrap gap-4">
              <PillLink to="/eventos" search={{}}>
                Ver cartelera
              </PillLink>
              <PillLink to="/tienda">Ir a la tienda</PillLink>
            </div>
          </div>
        ) : (
          <div className="mt-10 grid gap-12 lg:grid-cols-[1.6fr_1fr] lg:items-start">
            <div>
              <Hairline />
              {items.map((item) =>
                isProduct(item) ? (
                  <ProductLine key={item.key} item={item} />
                ) : (
                  <TicketLine key={item.key} item={item} />
                ),
              )}
            </div>

            <aside className="grid gap-5 rounded-card bg-plaster p-7 lg:sticky lg:top-28">
              <SectionTitle>Resumen</SectionTitle>
              <Row label={`Subtotal (${totals.count})`} value={money(totals.subtotal)} />
              <Row label="Cargos por servicio" value={money(totals.fees)} />
              <Hairline />
              <div className="flex items-baseline justify-between">
                <span className="text-body">Total</span>
                <span className="text-subheading">{money(totals.total)}</span>
              </div>
              <PillLink to="/checkout">Ir a pagar</PillLink>
              {items.some((item) => !isProduct(item)) ? (
                <MetaText>Tus butacas están reservadas por tiempo limitado.</MetaText>
              ) : null}
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

function TicketLine({ item }: { item: CartItem }) {
  return (
    <div className="grid gap-4 border-b border-ash py-7 md:grid-cols-[1.4fr_auto_auto] md:items-center">
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
        {/* La cantidad la fija la reserva; para cambiarla se vuelve a elegir. */}
        <MetaText className="inline">
          {item.quantity} {item.quantity === 1 ? "ticket" : "tickets"}
        </MetaText>
      </div>

      <LineTotal item={item} />
    </div>
  );
}

/** Producto de la tienda: sin reserva, la cantidad se cambia aquí mismo (máx. 8 por línea). */
function ProductLine({ item }: { item: CartItem }) {
  const setQuantity = (quantity: number) =>
    void addToCart([{ ...item, quantity }]).catch(() => undefined);
  return (
    <div className="grid gap-4 border-b border-ash py-7 md:grid-cols-[1.4fr_auto_auto] md:items-center">
      <div className="flex items-center gap-4">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" className="size-16 rounded-card object-cover" />
        ) : null}
        <div className="grid gap-1">
          {item.productSlug ? (
            <Link
              to="/tienda/$slug"
              params={{ slug: item.productSlug }}
              className="text-subheading hover:opacity-60"
            >
              {item.eventTitle}
            </Link>
          ) : (
            <span className="text-subheading">{item.eventTitle}</span>
          )}
          <MetaText>Tienda</MetaText>
        </div>
      </div>

      <div className="flex items-center gap-3" aria-label="Cantidad">
        <GhostButton
          arrow={false}
          aria-label="Quitar uno"
          disabled={item.quantity <= 1}
          onClick={() => setQuantity(item.quantity - 1)}
        >
          −
        </GhostButton>
        <span className="text-body tabular-nums">{item.quantity}</span>
        <GhostButton
          arrow={false}
          aria-label="Agregar uno"
          disabled={item.quantity >= 8}
          onClick={() => setQuantity(item.quantity + 1)}
        >
          +
        </GhostButton>
      </div>

      <LineTotal item={item} />
    </div>
  );
}

function LineTotal({ item }: { item: CartItem }) {
  return (
    <div className="grid justify-items-end gap-2">
      <span className="text-body">{money((item.unitPrice + item.unitFee) * item.quantity)}</span>
      <GhostButton arrow={false} onClick={() => void removeFromCart(item.key)}>
        <span className="text-graphite underline">Quitar</span>
      </GhostButton>
    </div>
  );
}
