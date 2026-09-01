import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Wordmark } from "@/components/kit/Wordmark";
import { TextInput } from "@/components/kit/Field";
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/format";
import { useCart } from "@/lib/cart";
import { useAuth } from "@/lib/useAuth";

export function SiteHeader() {
  const navigate = useNavigate();
  const { totals } = useCart();
  const { session, isAdmin } = useAuth();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    navigate({ to: "/eventos", search: q ? { q } : {} });
    setOpen(false);
  }

  return (
    <header className="sticky top-0 z-40 bg-paper">
      <div className="mx-auto flex max-w-[1240px] items-center gap-6 px-5 py-4 md:px-8">
        <Link to="/" className="shrink-0">
          <Wordmark size="sm" asLink={false} />
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          {CATEGORIES.map((category) => (
            <Link
              key={category}
              to="/eventos"
              search={{ category }}
              className="text-body text-carbon transition-opacity hover:opacity-60"
            >
              {CATEGORY_LABELS[category]}
            </Link>
          ))}
        </nav>

        <form onSubmit={submit} className="ml-auto hidden w-[260px] md:block">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar artista, evento o recinto"
            aria-label="Buscar"
            className="py-2 text-body"
          />
        </form>

        <div className="ml-auto flex items-center gap-5 md:ml-0">
          {session ? (
            <Link
              to={isAdmin ? "/admin" : "/mi-cuenta"}
              className="hidden text-body text-carbon hover:opacity-60 sm:block"
            >
              {isAdmin ? "Panel" : "Mis tickets"}
            </Link>
          ) : (
            <Link
              to="/auth"
              search={{}}
              className="hidden text-body text-carbon hover:opacity-60 sm:block"
            >
              Ingresa
            </Link>
          )}
          <Link to="/carro" className="text-body text-carbon hover:opacity-60">
            Carro{totals.count > 0 ? ` (${totals.count})` : ""}
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-body text-carbon md:hidden"
            aria-expanded={open}
          >
            Menú
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-carbon bg-paper px-5 pb-6 pt-4 md:hidden">
          <form onSubmit={submit} className="mb-4">
            <TextInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar"
              aria-label="Buscar"
            />
          </form>
          <div className="grid gap-3">
            {CATEGORIES.map((category) => (
              <Link
                key={category}
                to="/eventos"
                search={{ category }}
                onClick={() => setOpen(false)}
                className="text-lead text-carbon"
              >
                {CATEGORY_LABELS[category]}
              </Link>
            ))}
            {session ? (
              <Link
                to={isAdmin ? "/admin" : "/mi-cuenta"}
                onClick={() => setOpen(false)}
                className="text-lead text-carbon"
              >
                {isAdmin ? "Panel" : "Mis tickets"}
              </Link>
            ) : (
              <Link
                to="/auth"
                search={{}}
                onClick={() => setOpen(false)}
                className="text-lead text-carbon"
              >
                Ingresa
              </Link>
            )}
            <Link to="/ayuda" onClick={() => setOpen(false)} className="text-lead text-carbon">
              Ayuda
            </Link>
          </div>
        </div>
      ) : null}

      <div aria-hidden className="h-px w-full bg-carbon" />
    </header>
  );
}
