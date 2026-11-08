import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import {
  Caption,
  DisplayHeading,
  Hairline,
  Lead,
  MetaText,
  SectionTitle,
  UrgencyTag,
} from "@/components/kit/Text";
import { PillLink } from "@/components/kit/PillButton";
import { HeroMedia } from "@/components/site/HeroMedia";
import { getEvent, trackView } from "@/lib/catalog.functions";
import { CATEGORY_LABELS, clock, longDate, money } from "@/lib/format";

const eventQuery = (slug: string) =>
  queryOptions({
    queryKey: ["event", slug],
    queryFn: async () => {
      const data = await getEvent({ data: { slug } });
      if (!data) throw notFound();
      return data;
    },
  });

export const Route = createFileRoute("/evento/$slug")({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(eventQuery(params.slug)),
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Evento no disponible — Ticketera" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const { event } = loaderData;
    const title = `${event.title} — Tickets | Ticketera`;
    const description =
      event.description?.slice(0, 155) ??
      `Compra tickets para ${event.title} en ${event.venueName ?? "Chile"}.`;
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        ...(event.imageUrl && event.imageUrl.startsWith("https://")
          ? [
              { property: "og:image", content: event.imageUrl },
              { name: "twitter:image", content: event.imageUrl },
            ]
          : []),
      ],
    };
  },
  component: EventDetail,
  errorComponent: ({ error }) => (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8" role="alert">
        <SectionTitle>No pudimos cargar el evento</SectionTitle>
        <MetaText className="mt-3">
          {error instanceof Error ? error.message : String(error)}
        </MetaText>
      </div>
    </PublicLayout>
  ),
  notFoundComponent: () => (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
        <SectionTitle>Este evento no existe o ya no está en venta</SectionTitle>
        <Link to="/eventos" search={{}} className="mt-6 inline-block text-body">
          Ver cartelera →
        </Link>
      </div>
    </PublicLayout>
  ),
});

function EventDetail() {
  const { slug } = Route.useParams();
  const { data } = useSuspenseQuery(eventQuery(slug));
  const { event, dates, queue } = data;

  useEffect(() => {
    void trackView({ data: { eventId: event.id } }).catch(() => undefined);
  }, [event.id]);

  return (
    <PublicLayout>
      <HeroMedia imageUrl={event.imageUrl} alt={event.title}>
        <Caption className="text-paper/80">
          {CATEGORY_LABELS[event.category] ?? event.category}
        </Caption>
        <DisplayHeading className="mt-5">{event.title}</DisplayHeading>
        {event.artist ? <Lead className="mt-6 text-paper/85">{event.artist}</Lead> : null}
        {event.urgencyNote ? (
          <div className="mt-4">
            <UrgencyTag>{event.urgencyNote}</UrgencyTag>
          </div>
        ) : null}
        {event.description ? (
          <p className="mt-5 max-w-[62ch] text-body text-paper/85">{event.description}</p>
        ) : null}
        <div className="mt-6 grid gap-1">
          {event.venueName ? (
            <span className="text-body text-paper/70">
              {[event.venueName, event.city].filter(Boolean).join(" · ")}
            </span>
          ) : null}
          {event.ageRestriction ? (
            <span className="text-body text-paper/70">Edad: {event.ageRestriction}</span>
          ) : null}
        </div>
        <div className="mt-8">
          <a href="#fechas" className="text-body text-paper underline underline-offset-4">
            Ver fechas y precios ↓
          </a>
        </div>
      </HeroMedia>

      <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-8 md:py-20">
        {queue?.enabled ? (
          <MetaText className="mb-10">
            Este evento usa fila virtual: al comprar entrarás a una fila y recibirás una ventana de{" "}
            {queue.windowMinutes} minutos.
          </MetaText>
        ) : null}

        <div id="fechas" className="mt-0">
          <SectionTitle>Fechas y precios</SectionTitle>
          <Hairline className="mt-6" />

          <div className="grid">
            {dates.map((date) => {
              const min = date.tickets.length
                ? Math.min(...date.tickets.map((t) => t.price))
                : null;
              const remaining = date.tickets.reduce(
                (acc, t) => acc + Math.max(0, t.capacity - t.sold),
                0,
              );
              return (
                <div
                  key={date.id}
                  className="grid gap-4 border-b border-ash py-7 md:grid-cols-[1.2fr_1fr_auto] md:items-center"
                >
                  <div className="grid gap-1">
                    <span className="text-subheading">{longDate(date.startsAt)}</span>
                    <MetaText>
                      {clock(date.startsAt)} hrs · {date.venue?.name} · {date.venue?.city}
                    </MetaText>
                  </div>

                  <div className="grid gap-1">
                    <span className="text-body">
                      {min != null ? `Desde ${money(min)}` : "Precios por confirmar"}
                    </span>
                    <MetaText>
                      {remaining > 0 ? `${remaining} tickets disponibles` : "Agotado"}
                    </MetaText>
                  </div>

                  <div className="md:justify-self-end">
                    {date.onSale && remaining > 0 ? (
                      <PillLink to="/comprar/$dateId" params={{ dateId: date.id }}>
                        Elegir asientos
                      </PillLink>
                    ) : (
                      <MetaText>{date.onSale ? "Agotado" : "Venta cerrada"}</MetaText>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-10 grid gap-3">
            {dates[0]?.tickets.map((ticket) => (
              <div key={ticket.id} className="flex items-baseline justify-between">
                <span className="text-body">{ticket.name}</span>
                <MetaText className="inline">
                  {money(ticket.price)} + {money(ticket.fee)} cargo por servicio
                </MetaText>
              </div>
            ))}
          </div>
        </div>
      </div>
    </PublicLayout>
  );
}
