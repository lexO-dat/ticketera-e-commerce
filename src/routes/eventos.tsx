import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";

import { PublicLayout } from "@/components/site/PublicLayout";
import { EventCard } from "@/components/site/EventCard";
import { DisplayHeading, MetaText, SectionTitle } from "@/components/kit/Text";
import { Field, Select, TextInput } from "@/components/kit/Field";
import { listEvents } from "@/lib/catalog.functions";
import { CATEGORIES, CATEGORY_LABELS } from "@/lib/format";

const searchSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  city: z.string().optional(),
  sort: z.enum(["date", "popular", "price"]).optional(),
});

type EventsSearch = z.infer<typeof searchSchema>;

const eventsQuery = (search: EventsSearch) =>
  queryOptions({
    queryKey: ["events", "list", search],
    queryFn: () => listEvents({ data: search }),
  });

export const Route = createFileRoute("/eventos")({
  validateSearch: (search: Record<string, unknown>) => searchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    context.queryClient.ensureQueryData(eventsQuery(deps));
  },
  head: () => ({
    meta: [
      { title: "Cartelera de eventos — Ticketera" },
      {
        name: "description",
        content:
          "Busca y filtra shows en vivo por categoría, ciudad y precio. Compra tickets con mapa de asientos.",
      },
      { property: "og:title", content: "Cartelera de eventos — Ticketera" },
      {
        property: "og:description",
        content: "Todos los shows en venta, filtrables por ciudad y categoría.",
      },
    ],
  }),
  component: EventsPage,
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
      <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">Sin eventos.</div>
    </PublicLayout>
  ),
});

function EventsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/eventos" });
  const { data } = useSuspenseQuery(eventsQuery(search));

  function update(patch: Partial<EventsSearch>) {
    navigate({ search: (prev) => ({ ...prev, ...patch }) });
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-14 md:px-8 md:py-20">
        <DisplayHeading>Cartelera</DisplayHeading>

        <div className="mt-10 grid gap-6 md:grid-cols-4">
          <Field label="Buscar">
            <TextInput
              value={search.q ?? ""}
              onChange={(e) => update({ q: e.target.value || undefined })}
              placeholder="Artista, show o recinto"
            />
          </Field>
          <Field label="Categoría">
            <Select
              value={search.category ?? ""}
              onChange={(e) => update({ category: e.target.value || undefined })}
            >
              <option value="">Todas</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ciudad">
            <Select
              value={search.city ?? ""}
              onChange={(e) => update({ city: e.target.value || undefined })}
            >
              <option value="">Todas</option>
              {data.cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ordenar por">
            <Select
              value={search.sort ?? "date"}
              onChange={(e) => update({ sort: e.target.value as EventsSearch["sort"] })}
            >
              <option value="date">Próximas fechas</option>
              <option value="popular">Más vendidos</option>
              <option value="price">Precio más bajo</option>
            </Select>
          </Field>
        </div>

        <div aria-hidden className="mt-10 h-px w-full bg-carbon" />
        <MetaText className="mt-4">{data.events.length} eventos encontrados</MetaText>

        {data.events.length === 0 ? (
          <div className="py-20">
            <SectionTitle>Sin resultados</SectionTitle>
            <MetaText className="mt-3">Prueba con otro término o quita los filtros.</MetaText>
          </div>
        ) : (
          <div className="mt-10 grid gap-12 sm:grid-cols-2 lg:grid-cols-3">
            {data.events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </PublicLayout>
  );
}
