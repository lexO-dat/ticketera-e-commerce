import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, MetaText } from "@/components/kit/Text";
import { PillLink } from "@/components/kit/PillButton";
import { verifyEmail } from "@/lib/auth.functions";

export const Route = createFileRoute("/verificar-email")({
  ssr: false,
  validateSearch: (search) => z.object({ token: z.string().optional() }).parse(search),
  head: () => ({
    meta: [{ title: "Verificar email — Ticketera" }, { name: "robots", content: "noindex" }],
  }),
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<"working" | "done" | "error">(token ? "working" : "error");
  const [message, setMessage] = useState("El enlace no es válido.");

  useEffect(() => {
    if (!token) return;
    verifyEmail({ data: { token } })
      .then(() => setState("done"))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "El enlace no es válido o expiró.");
        setState("error");
      });
  }, [token]);

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[520px] px-5 py-20 md:px-8 md:py-28">
        <Caption className="text-graphite">Tu cuenta</Caption>
        <DisplayHeading className="mt-4">
          {state === "done"
            ? "Email verificado"
            : state === "working"
              ? "Verificando…"
              : "No pudimos verificar"}
        </DisplayHeading>
        <MetaText className="mt-4">
          {state === "done"
            ? "Listo: tu email quedó verificado."
            : state === "working"
              ? "Un momento por favor."
              : message}
        </MetaText>
        {state !== "working" ? (
          <div className="mt-8">
            <PillLink to="/mi-cuenta">Ir a mi cuenta</PillLink>
          </div>
        ) : null}
      </div>
    </PublicLayout>
  );
}
