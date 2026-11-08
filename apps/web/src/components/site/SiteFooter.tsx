import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Wordmark } from "@/components/kit/Wordmark";
import { Caption, MetaText } from "@/components/kit/Text";
import { TextInput } from "@/components/kit/Field";
import { PillButton } from "@/components/kit/PillButton";
import { subscribeNewsletter } from "@/lib/catalog.functions";
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/format";

export function SiteFooter() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    try {
      await subscribeNewsletter({ data: { email } });
      setState("done");
      setEmail("");
    } catch {
      setState("error");
    }
  }

  return (
    <footer className="bg-paper">
      <div aria-hidden className="h-px w-full bg-carbon" />
      <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-16 md:grid-cols-4 md:px-8">
        <div className="grid gap-5">
          <Wordmark size="sm" asLink={false} />
          <MetaText>
            Tickets para música en vivo, teatro, festivales y deportes. Compra directa, sin
            intermediarios.
          </MetaText>
        </div>

        <div className="grid content-start gap-3">
          <Caption className="text-graphite">Categorías</Caption>
          {CATEGORIES.map((category) => (
            <Link
              key={category}
              to="/eventos"
              search={{ category }}
              className="text-body text-carbon hover:opacity-60"
            >
              {CATEGORY_LABELS[category]}
            </Link>
          ))}
        </div>

        <div className="grid content-start gap-3">
          <Caption className="text-graphite">Ayuda</Caption>
          <Link to="/ayuda" className="text-body text-carbon hover:opacity-60">
            Preguntas frecuentes
          </Link>
          <Link to="/orden" className="text-body text-carbon hover:opacity-60">
            Buscar mi orden
          </Link>
          <Link to="/contacto" className="text-body text-carbon hover:opacity-60">
            Contacto
          </Link>
          <Link to="/auth" className="text-body text-graphite hover:opacity-60">
            Acceso staff
          </Link>
        </div>

        <div className="grid content-start gap-4">
          <Caption className="text-graphite">Nuevos shows en tu correo</Caption>
          <form onSubmit={submit} className="grid gap-3">
            <TextInput
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@correo.cl"
              aria-label="Correo"
            />
            <PillButton type="submit" disabled={state === "sending"}>
              {state === "done" ? "Suscrito" : "Suscribirme"}
            </PillButton>
          </form>
          {state === "error" ? <MetaText>No pudimos registrar tu correo.</MetaText> : null}
        </div>
      </div>

      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 px-5 pb-10 md:px-8">
        <MetaText>© {new Date().getFullYear()} Ticketera</MetaText>
        <MetaText>Santiago de Chile</MetaText>
      </div>
    </footer>
  );
}
