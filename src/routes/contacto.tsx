import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { PillButton } from "@/components/kit/PillButton";
import { Field, TextArea, TextInput } from "@/components/kit/Field";

export const Route = createFileRoute("/contacto")({
  head: () => ({
    meta: [
      { title: "Contacto y soporte de compras — Ticketera" },
      {
        name: "description",
        content:
          "Contacta al equipo de Ticketera por problemas de compra, cambios de titular o productoras.",
      },
      { property: "og:title", content: "Contacto — Ticketera" },
      { property: "og:description", content: "Soporte de compras y contacto para productoras." },
    ],
  }),
  component: ContactPage,
});

function ContactPage() {
  const [sent, setSent] = useState(false);

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-16 md:px-8 md:py-24">
        <Caption className="text-graphite">Hablemos</Caption>
        <DisplayHeading className="mt-4">Contacto</DisplayHeading>

        <div className="mt-14 grid gap-16 md:grid-cols-[1fr_1fr]">
          <div className="grid gap-8">
            <div className="grid gap-2">
              <SectionTitle>Soporte de compras</SectionTitle>
              <MetaText>soporte@ticketera.cl · Lunes a viernes, 9 a 19 hrs</MetaText>
            </div>
            <Hairline />
            <div className="grid gap-2">
              <SectionTitle>Productoras y recintos</SectionTitle>
              <MetaText>
                Si quieres vender tickets con nosotros, escribe a productoras@ticketera.cl y te
                contactamos con una propuesta comercial.
              </MetaText>
            </div>
            <Hairline />
            <div className="grid gap-2">
              <SectionTitle>Prensa</SectionTitle>
              <MetaText>prensa@ticketera.cl</MetaText>
            </div>
          </div>

          {sent ? (
            <div className="grid gap-4 rounded-card bg-plaster p-8">
              <SectionTitle>Mensaje enviado</SectionTitle>
              <MetaText>Gracias por escribirnos. Respondemos dentro de un día hábil.</MetaText>
            </div>
          ) : (
            <form
              className="grid gap-6 rounded-card bg-plaster p-8"
              onSubmit={(e) => {
                e.preventDefault();
                setSent(true);
              }}
            >
              <Field label="Nombre">
                <TextInput required placeholder="Tu nombre" />
              </Field>
              <Field label="Email">
                <TextInput required type="email" placeholder="tu@correo.cl" />
              </Field>
              <Field label="Código de orden" hint="Opcional, acelera la respuesta">
                <TextInput placeholder="TKXXXXXXXX" />
              </Field>
              <Field label="Mensaje">
                <TextArea required rows={5} placeholder="Cuéntanos qué necesitas" />
              </Field>
              <PillButton type="submit">Enviar mensaje</PillButton>
            </form>
          )}
        </div>
      </div>
    </PublicLayout>
  );
}
