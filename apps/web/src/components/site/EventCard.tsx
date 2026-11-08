import { Link } from "@tanstack/react-router";

import { Caption, MetaText, SectionTitle, UrgencyTag } from "@/components/kit/Text";
import { CATEGORY_LABELS, money, shortDate } from "@/lib/format";
import type { CatalogEvent } from "@/lib/catalog.functions";

export function EventCard({ event }: { event: CatalogEvent }) {
  const soldout = event.status === "soldout";

  return (
    <Link
      to="/evento/$slug"
      params={{ slug: event.slug }}
      className="group grid gap-4"
      aria-label={event.title}
    >
      <div className="relative aspect-[4/3] overflow-hidden rounded-card bg-plaster">
        {event.imageUrl ? (
          <img
            src={event.imageUrl}
            alt={event.title}
            loading="lazy"
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          />
        ) : null}
        <span className="absolute left-3 top-3 rounded-pill bg-paper px-3 py-1 font-roboto text-caption uppercase tracking-[0.14em]">
          {CATEGORY_LABELS[event.category] ?? event.category}
        </span>
      </div>

      <div className="grid gap-1">
        <Caption className="text-graphite">
          {event.nextDate ? shortDate(event.nextDate) : "Próximamente"}
          {event.datesCount > 1 ? ` · ${event.datesCount} fechas` : ""}
        </Caption>
        <SectionTitle as="h3" className="text-subheading">
          {event.title}
        </SectionTitle>
        <MetaText>{[event.venueName, event.city].filter(Boolean).join(" · ")}</MetaText>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-body">
            {soldout ? "Agotado" : event.minPrice != null ? `Desde ${money(event.minPrice)}` : "—"}
          </span>
          {!soldout && event.urgencyNote ? <UrgencyTag>{event.urgencyNote}</UrgencyTag> : null}
        </div>
      </div>
    </Link>
  );
}
