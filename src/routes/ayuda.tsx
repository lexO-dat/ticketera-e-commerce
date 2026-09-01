import { createFileRoute } from "@tanstack/react-router";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { PillLink } from "@/components/kit/PillButton";

const FAQS = [
  {
    q: "¿Cómo funciona la fila virtual?",
    a: "En eventos de alta demanda activamos una fila virtual. Al entrar recibes una posición y, cuando llega tu turno, se abre una ventana de compra con tiempo limitado para elegir asientos y pagar.",
  },
  {
    q: "¿Por cuánto tiempo se reservan mis butacas?",
    a: "Al seleccionar butacas las reservamos por 10 minutos. Si la reserva expira, las butacas vuelven a estar disponibles para otras personas.",
  },
  {
    q: "¿Qué son los cargos por servicio?",
    a: "Es la comisión de la plataforma por la gestión de la venta, emisión de tickets y soporte. Se muestra siempre desagregada antes de pagar.",
  },
  {
    q: "¿Cómo recibo mis tickets?",
    a: "Al finalizar la compra generamos un ticket digital por cada entrada, con un código único. También puedes recuperarlos con tu código de orden.",
  },
  {
    q: "¿Puedo cambiar el nombre del asistente?",
    a: "Sí, escríbenos desde la página de contacto con tu código de orden y el nombre correcto hasta 48 horas antes del evento.",
  },
  {
    q: "¿Qué pasa si el evento se reprograma?",
    a: "Tu ticket mantiene validez para la nueva fecha. Si no puedes asistir, gestionamos la devolución del valor del ticket.",
  },
];

export const Route = createFileRoute("/ayuda")({
  head: () => ({
    meta: [
      { title: "Centro de ayuda y preguntas frecuentes — Ticketera" },
      {
        name: "description",
        content:
          "Resuelve dudas sobre fila virtual, reservas de butacas, cargos por servicio y tickets digitales.",
      },
      { property: "og:title", content: "Centro de ayuda — Ticketera" },
      {
        property: "og:description",
        content: "Preguntas frecuentes sobre compra de tickets, fila virtual y devoluciones.",
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQS.map((item) => ({
            "@type": "Question",
            name: item.q,
            acceptedAnswer: { "@type": "Answer", text: item.a },
          })),
        }),
      },
    ],
  }),
  component: HelpPage,
});

function HelpPage() {
  return (
    <PublicLayout>
      <div className="mx-auto max-w-[900px] px-5 py-16 md:px-8 md:py-24">
        <Caption className="text-graphite">Centro de ayuda</Caption>
        <DisplayHeading className="mt-4">Preguntas frecuentes</DisplayHeading>

        <Hairline className="mt-12" />
        <div className="grid">
          {FAQS.map((item) => (
            <details key={item.q} className="group border-b border-ash py-7">
              <summary className="flex cursor-pointer items-center justify-between gap-6 text-subheading">
                {item.q}
                <span aria-hidden className="text-graphite transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="mt-4 max-w-[62ch] text-body text-graphite">{item.a}</p>
            </details>
          ))}
        </div>

        <div className="mt-14 grid gap-4">
          <SectionTitle>¿No encuentras tu respuesta?</SectionTitle>
          <MetaText>Escríbenos y te respondemos dentro de un día hábil.</MetaText>
          <div>
            <PillLink to="/contacto">Ir a contacto</PillLink>
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
