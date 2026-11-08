import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, MetaText } from "@/components/kit/Text";
import { PillButton } from "@/components/kit/PillButton";
import { Field, TextInput } from "@/components/kit/Field";

export const Route = createFileRoute("/orden/")({
  head: () => ({
    meta: [
      { title: "Buscar mi orden — Ticketera" },
      {
        name: "description",
        content: "Ingresa tu código de orden para ver tus tickets y detalles de compra.",
      },
      { property: "og:title", content: "Buscar mi orden — Ticketera" },
      { property: "og:description", content: "Recupera tus tickets con el código de orden." },
    ],
  }),
  component: OrderLookup,
});

function OrderLookup() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[720px] px-5 py-16 md:px-8 md:py-24">
        <Caption className="text-graphite">Mis tickets</Caption>
        <DisplayHeading className="mt-4">Buscar mi orden</DisplayHeading>
        <MetaText className="mt-4">
          El código de orden empieza con TK y está en el email de confirmación.
        </MetaText>

        <form
          className="mt-10 grid gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim().length < 4) return;
            void navigate({ to: "/orden/$code", params: { code: code.trim().toUpperCase() } });
          }}
        >
          <Field label="Código de orden">
            <TextInput
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="TKXXXXXXXX"
            />
          </Field>
          <PillButton type="submit">Ver mis tickets</PillButton>
        </form>
      </div>
    </PublicLayout>
  );
}
