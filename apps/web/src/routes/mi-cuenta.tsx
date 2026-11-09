import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillLink } from "@/components/kit/PillButton";
import { TicketCard } from "@/components/site/TicketCard";
import {
  ORDER_STATUS_LABELS,
  myAccount,
  type AccountTicket,
  type Purchase,
} from "@/lib/account.functions";
import { refreshAuth, useAuth } from "@/lib/useAuth";
import { signOut } from "@/lib/auth.functions";
import { longDate, money } from "@/lib/format";

export const Route = createFileRoute("/mi-cuenta")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Mis tickets y eventos — Ticketera" },
      {
        name: "description",
        content:
          "Revisa tus tickets digitales, tus próximos shows y el historial de eventos a los que asististe.",
      },
      { property: "og:title", content: "Mis tickets y eventos — Ticketera" },
      {
        property: "og:description",
        content:
          "Entradas digitales, próximos shows e historial de compras en tu cuenta Ticketera.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccountPage,
});

function AccountPage() {
  const navigate = useNavigate();
  const { loading, session } = useAuth();

  useEffect(() => {
    if (!loading && !session) {
      void navigate({ to: "/auth", search: { redirect: "/mi-cuenta" }, replace: true });
    }
  }, [loading, session, navigate]);

  const accountQuery = useQuery({
    queryKey: ["my-account", session?.user.id],
    queryFn: () => myAccount(),
    enabled: Boolean(session),
  });

  const tickets = accountQuery.data?.tickets ?? [];
  const purchases = accountQuery.data?.purchases ?? [];
  // Un evento pasa a "pasados" unas horas después de empezar (el show puede seguir en curso).
  const cutoff = Date.now() - 6 * 3600_000;
  const upcoming = tickets.filter((t) => !t.startsAt || Date.parse(t.startsAt) >= cutoff);
  const past = tickets.filter((t) => t.startsAt && Date.parse(t.startsAt) < cutoff);

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-8 md:py-20">
        <Caption className="text-graphite">Mi cuenta</Caption>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
          <DisplayHeading>Mis tickets</DisplayHeading>
          <GhostButton
            arrow={false}
            onClick={() => {
              void signOut()
                .then(() => refreshAuth())
                .then(() => navigate({ to: "/", replace: true }));
            }}
          >
            <span className="text-graphite underline">Cerrar sesión</span>
          </GhostButton>
        </div>
        <MetaText className="mt-4">{session?.user.email}</MetaText>

        {loading || accountQuery.isLoading ? (
          <MetaText className="mt-12">Cargando tus tickets…</MetaText>
        ) : tickets.length === 0 && purchases.length === 0 ? (
          <div className="mt-14 grid justify-items-start gap-6">
            <SectionTitle>Todavía no tienes compras</SectionTitle>
            <MetaText>Cuando compres tickets aparecerán acá con sus códigos QR.</MetaText>
            <PillLink to="/eventos" search={{}}>
              Ver cartelera
            </PillLink>
          </div>
        ) : (
          <>
            <TicketGroup
              title="Próximos shows"
              tickets={upcoming}
              empty="No tienes entradas para próximos shows."
            />
            {past.length > 0 ? <TicketGroup title="Eventos pasados" tickets={past} /> : null}
            <Purchases purchases={purchases} />
          </>
        )}
      </div>
    </PublicLayout>
  );
}

/** Entradas agrupadas por función (evento y fecha), con la portada del evento. */
function TicketGroup({
  title,
  tickets,
  empty,
}: {
  title: string;
  tickets: AccountTicket[];
  empty?: string;
}) {
  const shows = new Map<string, AccountTicket[]>();
  for (const ticket of tickets) {
    const key = `${ticket.name.split(" — ")[0]}|${ticket.startsAt ?? ""}`;
    shows.set(key, [...(shows.get(key) ?? []), ticket]);
  }
  return (
    <section className="mt-16">
      <SectionTitle>{title}</SectionTitle>
      <Hairline className="mt-6" />
      {tickets.length === 0 ? (
        <MetaText className="mt-6">{empty}</MetaText>
      ) : (
        <div className="grid gap-12 pt-8">
          {[...shows.values()].map((group) => {
            const first = group[0]!;
            const eventTitle = first.name.split(" — ")[0] ?? first.name;
            return (
              <article key={first.id} className="grid gap-6">
                <div className="grid gap-4 sm:grid-cols-[160px_1fr] sm:items-center">
                  <div className="aspect-[4/3] overflow-hidden rounded-card bg-plaster">
                    {first.imageUrl ? (
                      <img
                        src={first.imageUrl}
                        alt={eventTitle}
                        loading="lazy"
                        className="size-full object-cover"
                      />
                    ) : null}
                  </div>
                  <div className="grid gap-1">
                    {first.eventSlug ? (
                      <Link
                        to="/evento/$slug"
                        params={{ slug: first.eventSlug }}
                        className="text-lead hover:opacity-60"
                      >
                        {eventTitle}
                      </Link>
                    ) : (
                      <span className="text-lead">{eventTitle}</span>
                    )}
                    <MetaText>
                      {first.startsAt ? longDate(first.startsAt) : ""}
                      {first.venueName ? ` · ${first.venueName}` : ""}
                    </MetaText>
                    <MetaText>
                      {group.length} {group.length === 1 ? "entrada" : "entradas"}
                    </MetaText>
                  </div>
                </div>
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                  {group.map((ticket) => (
                    <TicketCard key={ticket.id} ticket={ticket} collapsible />
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Historial de compras pagadas (entradas y productos), con enlace al detalle de cada orden. */
function Purchases({ purchases }: { purchases: Purchase[] }) {
  if (purchases.length === 0) return null;
  return (
    <section className="mt-16">
      <SectionTitle>Mis compras</SectionTitle>
      <Hairline className="mt-6" />
      <div className="grid">
        {purchases.map((purchase) => (
          <Link
            key={purchase.orderCode}
            to="/orden/$code"
            params={{ code: purchase.orderCode }}
            className="grid gap-1 border-b border-ash py-5 hover:opacity-70"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-body">Orden {purchase.orderCode}</span>
              <MetaText className="inline">
                {money(purchase.total)} · {ORDER_STATUS_LABELS[purchase.status]}
              </MetaText>
            </div>
            <MetaText>
              {longDate(purchase.createdAt)} ·{" "}
              {purchase.lines.map((line) => `${line.quantity} × ${line.name}`).join(" · ")}
            </MetaText>
          </Link>
        ))}
      </div>
    </section>
  );
}
