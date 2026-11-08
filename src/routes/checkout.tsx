import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { RequireAuth } from "@/components/site/RequireAuth";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillButton, PillLink } from "@/components/kit/PillButton";
import { Field, TextInput } from "@/components/kit/Field";
import { clearCart, useCart } from "@/lib/cart";
import { checkout, validatePromo } from "@/lib/orders.functions";
import { dateAndTime, money } from "@/lib/format";

export const Route = createFileRoute("/checkout")({
  head: () => ({
    meta: [
      { title: "Pago de tickets — Ticketera" },
      { name: "description", content: "Completa tus datos y paga tus tickets de forma segura." },
      { property: "og:title", content: "Pago de tickets — Ticketera" },
      { property: "og:description", content: "Checkout de tickets con pago en Webpay." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CheckoutRoute,
});

function CheckoutRoute() {
  return (
    <RequireAuth redirectTo="/checkout">
      <CheckoutPage />
    </RequireAuth>
  );
}


function CheckoutPage() {
  const { items, totals, loaded } = useCart();
  const navigate = useNavigate();
  // Una clave por visita: un doble clic o un reintento no crea dos órdenes ni dos cobros.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({ name: "", email: "", phone: "", document: "" });
  const [promo, setPromo] = useState("");
  const [promoState, setPromoState] = useState<
    { ok: true; code: string; percentOff: number } | { ok: false; reason: string } | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discount = promoState?.ok ? Math.round((totals.subtotal * promoState.percentOff) / 100) : 0;
  const grandTotal = totals.total - discount;

  async function applyPromo() {
    if (!promo.trim()) return;
    const result = await validatePromo({ data: { code: promo.trim() } });
    setPromoState(
      result.valid
        ? { ok: true, code: result.code, percentOff: result.percentOff }
        : { ok: false, reason: result.reason },
    );
  }

  async function pay() {
    if (items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await checkout({
        data: {
          idempotencyKey,
          buyer: {
            name: form.name,
            email: form.email,
            phone: form.phone || null,
            document: form.document || null,
          },
          promoCode: promoState?.ok ? promoState.code : null,
        },
      });
      clearCart();
      // El formulario de tarjeta vive en el adquirente (Webpay): aquí nunca se piden datos de tarjeta.
      if (result.redirectUrl) {
        window.location.assign(result.redirectUrl);
        return;
      }
      void navigate({ to: "/orden/$code", params: { code: result.orderCode } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos procesar el pago");
      setBusy(false);
    }
  }

  const valid = form.name.trim().length > 2 && /.+@.+\..+/.test(form.email);

  if (!loaded) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
          <MetaText>Cargando tu carro…</MetaText>
        </div>
      </PublicLayout>
    );
  }

  if (items.length === 0) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
          <SectionTitle>Tu carro está vacío</SectionTitle>
          <div className="mt-8">
            <PillLink to="/eventos" search={{}}>
              Ver cartelera
            </PillLink>
          </div>
        </div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-12 md:px-8 md:py-16">
        <Caption className="text-graphite">Paso final</Caption>
        <DisplayHeading className="mt-4">Pago</DisplayHeading>

        <div className="mt-12 grid gap-12 lg:grid-cols-[1.4fr_1fr] lg:items-start">
          <div className="grid gap-10">
            <section className="grid gap-6">
              <SectionTitle>Datos del comprador</SectionTitle>
              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="Nombre completo">
                  <TextInput
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Camila Rivas"
                  />
                </Field>
                <Field label="Email">
                  <TextInput
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="camila@correo.cl"
                  />
                </Field>
                <Field label="Teléfono">
                  <TextInput
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+56 9 1234 5678"
                  />
                </Field>
                <Field label="RUT o documento">
                  <TextInput
                    value={form.document}
                    onChange={(e) => setForm({ ...form, document: e.target.value })}
                    placeholder="12.345.678-9"
                  />
                </Field>
              </div>
            </section>

            <section className="grid gap-4">
              <SectionTitle>Medio de pago</SectionTitle>
              <MetaText>
                Al pagar te llevamos al formulario de Webpay; nunca ingresas tu tarjeta en este
                sitio. Entorno de demostración: el adquirente es simulado y decide por el email del
                comprador (@acceptme.com aprueba, @rejectme.com rechaza).
              </MetaText>
            </section>

            <section className="grid gap-4">
              <SectionTitle>Código de descuento</SectionTitle>
              <div className="flex flex-wrap items-end gap-4">
                <div className="min-w-[220px] flex-1">
                  <Field label="Código">
                    <TextInput
                      value={promo}
                      onChange={(e) => setPromo(e.target.value.toUpperCase())}
                      placeholder="EJ: SHOW10"
                    />
                  </Field>
                </div>
                <GhostButton onClick={() => void applyPromo()}>Aplicar</GhostButton>
              </div>
              {promoState ? (
                <MetaText>
                  {promoState.ok
                    ? `Código ${promoState.code} aplicado: ${promoState.percentOff}% de descuento.`
                    : promoState.reason}
                </MetaText>
              ) : null}
            </section>
          </div>

          <aside className="grid gap-5 rounded-card bg-plaster p-7 lg:sticky lg:top-28">
            <SectionTitle>Tu orden</SectionTitle>
            <div className="grid gap-4">
              {items.map((item) => (
                <div key={item.key} className="grid gap-1">
                  <span className="text-body">
                    {item.eventTitle} × {item.quantity}
                  </span>
                  <MetaText>
                    {dateAndTime(item.startsAt)} · {item.sectionName}
                    {item.seatLabel ? ` · ${item.seatLabel}` : ""}
                  </MetaText>
                </div>
              ))}
            </div>
            <Hairline />
            <SummaryRow label="Tickets" value={money(totals.subtotal)} />
            <SummaryRow label="Cargos por servicio" value={money(totals.fees)} />
            {discount > 0 ? <SummaryRow label="Descuento" value={`- ${money(discount)}`} /> : null}
            <Hairline />
            <div className="flex items-baseline justify-between">
              <span className="text-body">Total a pagar</span>
              <span className="text-subheading">{money(grandTotal)}</span>
            </div>

            {error ? (
              <p role="alert" className="text-body text-ember">
                {error}
              </p>
            ) : null}

            <PillButton onClick={() => void pay()} disabled={busy || !valid}>
              {busy ? "Procesando…" : `Pagar ${money(grandTotal)}`}
            </PillButton>
            <MetaText>
              Al pagar aceptas los términos de compra. Recibirás tus tickets con código QR.
            </MetaText>
          </aside>
        </div>
      </div>
    </PublicLayout>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <MetaText className="inline">{label}</MetaText>
      <span className="text-body">{value}</span>
    </div>
  );
}
