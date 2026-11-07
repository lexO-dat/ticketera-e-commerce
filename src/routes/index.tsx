import { createFileRoute, Link } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";

import { PublicLayout } from "@/components/site/PublicLayout";
import { EventCard } from "@/components/site/EventCard";
import { HeroMedia } from "@/components/site/HeroMedia";
import {
  Caption,
  DisplayHeading,
  Lead,
  MetaText,
  SectionBand,
  SectionTitle,
  UrgencyTag,
} from "@/components/kit/Text";
import { PillLink } from "@/components/kit/PillButton";
import { listEvents } from "@/lib/catalog.functions";
import { CATEGORIES, CATEGORY_LABELS, dateAndTime, money } from "@/lib/format";

const homeQuery = queryOptions({
  queryKey: ["events", "home"],
  queryFn: () => listEvents({ data: {} }),
});

export const Route = createFileRoute("/")({
  loader: ({ context }) => {
    context.queryClient.ensureQueryData(homeQuery);
  },
  head: () => ({
    meta: [
      { title: "Ticketera — Tickets para shows en vivo en Chile" },
      {
        name: "description",
        content:
          "Compra tickets para conciertos, teatro, festivales y deportes. Fila virtual, mapa de asientos y confirmación inmediata.",
      },
      { property: "og:title", content: "Ticketera — Tickets para shows en vivo" },
      {
        property: "og:description",
        content: "Conciertos, teatro, festivales y deportes con compra directa y mapa de asientos.",
      },
    ],
  }),
  component: Home,
  errorComponent: ({ error }) => (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8" role="alert">
        <SectionTitle>No pudimos cargar la cartelera</SectionTitle>
        <MetaText className="mt-3">
          {error instanceof Error ? error.message : String(error)}
        </MetaText>
      </div>
    </PublicLayout>
  ),
  notFoundComponent: () => (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">Sin contenido.</div>
    </PublicLayout>
  ),
});

function Home() {
  const { data } = useSuspenseQuery(homeQuery);
  const events = data.events;
  const hero = events.find((e) => e.featured) ?? events[0];
  const rest = events.filter((e) => e.id !== hero?.id);
  const soon = rest.slice(0, 6);
  const byCategory = CATEGORIES.map((category) => ({
    category,
    count: events.filter((e) => e.category === category).length,
  })).filter((c) => c.count > 0);

  return (
    <PublicLayout>
      {hero ? (
        <HeroMedia imageUrl={hero.imageUrl} alt={hero.title}>
          <Caption className="text-paper/80">
            {hero.nextDate ? dateAndTime(hero.nextDate) : "Próximamente"}
          </Caption>
          <DisplayHeading className="mt-5">{hero.title}</DisplayHeading>
          <Lead className="mt-6 max-w-[46ch] text-paper/85">
            {hero.description ??
              "Un show para ver una vez en la vida. Elige tu asiento y asegura tu entrada."}
          </Lead>
          <div className="mt-8 flex flex-wrap items-center gap-6">
            <PillLink to="/evento/$slug" params={{ slug: hero.slug }}>
              Comprar tickets
            </PillLink>
            <span className="text-body text-paper">
              {hero.minPrice != null ? `Desde ${money(hero.minPrice)}` : ""}
            </span>
            {hero.urgencyNote ? <UrgencyTag>{hero.urgencyNote}</UrgencyTag> : null}
          </div>
          <span className="mt-6 block text-body text-paper/70">
            {[hero.venueName, hero.city].filter(Boolean).join(" · ")}
          </span>
        </HeroMedia>
      ) : null}

      <SectionBand tone="linen">
        <div className="mx-auto max-w-[1240px] px-5 md:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <SectionTitle>Próximos shows</SectionTitle>
            <Link to="/eventos" search={{}} className="text-body text-carbon hover:opacity-60">
              Ver toda la cartelera →
            </Link>
          </div>
          <div aria-hidden className="mt-6 h-px w-full bg-carbon" />
          <div className="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
            {soon.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        </div>
      </SectionBand>

      <SectionBand>
        <div className="mx-auto max-w-[1240px] px-5 md:px-8">
          <SectionTitle>Explora por categoría</SectionTitle>
          <div aria-hidden className="mt-6 h-px w-full bg-carbon" />
          <div className="mt-8 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {byCategory.map((item) => (
              <Link
                key={item.category}
                to="/eventos"
                search={{ category: item.category }}
                className="flex items-baseline justify-between border-b border-ash pb-4 hover:opacity-60"
              >
                <span className="text-subheading">{CATEGORY_LABELS[item.category]}</span>
                <MetaText>{item.count} eventos</MetaText>
              </Link>
            ))}
          </div>
        </div>
      </SectionBand>

      <SectionBand tone="linen">
        <div className="mx-auto grid max-w-[1240px] gap-10 px-5 md:grid-cols-3 md:px-8">
          {[
            {
              title: "Fila virtual",
              body: "En shows de alta demanda entras a una fila ordenada y recibes una ventana de compra propia.",
            },
            {
              title: "Mapa de asientos",
              body: "Elige butaca exacta con disponibilidad en vivo y reserva temporal de 10 minutos.",
            },
            {
              title: "Tickets digitales",
              body: "Tu orden llega con códigos únicos por asistente, listos para el control de acceso.",
            },
          ].map((item) => (
            <div key={item.title} className="grid gap-3">
              <div aria-hidden className="h-[3px] w-12 bg-sage" />
              <SectionTitle as="h3" className="text-subheading">
                {item.title}
              </SectionTitle>
              <MetaText>{item.body}</MetaText>
            </div>
          ))}
        </div>
      </SectionBand>
    </PublicLayout>
  );
}
