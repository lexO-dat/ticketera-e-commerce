import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { RequireAuth } from "@/components/site/RequireAuth";
import { SeatMap, type MapSeat } from "@/components/site/SeatMap";
import { QueuePanel, type QueueView } from "@/components/site/QueuePanel";
import {
  Caption,
  DisplayHeading,
  Hairline,
  MetaText,
  SectionTitle,
} from "@/components/kit/Text";
import { GhostButton, PillButton } from "@/components/kit/PillButton";
import { getSeatMap } from "@/lib/catalog.functions";
import { reserveTickets } from "@/lib/inventory.functions";
import { joinQueue, queueStatus } from "@/lib/queue.functions";
import { addToCart, type CartItem } from "@/lib/cart";
import { countdown, dateAndTime, money } from "@/lib/format";

export const Route = createFileRoute("/comprar/$dateId")({
  head: () => ({
    meta: [
      { title: "Selección de asientos — Ticketera" },
      { name: "description", content: "Elige tus asientos y completa tu compra de tickets." },
      { property: "og:title", content: "Selección de asientos — Ticketera" },
      { property: "og:description", content: "Mapa de butacas en vivo con reserva temporal." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PurchaseRoute,
});

function PurchaseRoute() {
  const { dateId } = Route.useParams();
  return (
    <RequireAuth redirectTo={`/comprar/${dateId}`}>
      <PurchasePage />
    </RequireAuth>
  );
}

function PurchasePage() {
  const { dateId } = Route.useParams();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<QueueView | null>(null);
  const [selected, setSelected] = useState<MapSeat[]>([]);
  const [generalQty, setGeneralQty] = useState<Record<string, number>>({});
  const [holdUntil, setHoldUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mapQuery = useQuery({
    queryKey: ["seatmap", dateId],
    queryFn: () => getSeatMap({ data: { eventDateId: dateId } }),
  });

  const eventId = mapQuery.data?.date.event?.id ?? null;

  // Sala de espera: entra una vez y consulta respetando el Retry-After del servidor (con jitter).
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (pollMs: number) => {
      timer = setTimeout(poll, pollMs * (0.8 + Math.random() * 0.4));
    };
    const poll = () => {
      queueStatus({ data: { eventId } })
        .then((view) => {
          if (cancelled) return;
          setQueue(view);
          // Admitido: se sigue consultando con calma para la cuenta regresiva y el vencimiento.
          schedule(view.state === "active" ? 15_000 : view.pollMs);
        })
        .catch(() => !cancelled && schedule(5_000));
    };
    joinQueue({ data: { eventId } })
      .then((view) => {
        if (cancelled) return;
        setQueue(view);
        schedule(view.state === "active" ? 15_000 : view.pollMs);
      })
      .catch(() => !cancelled && schedule(5_000));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [eventId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const data = mapQuery.data;
  const ticketBySection = useMemo(
    () => new Map((data?.tickets ?? []).map((t) => [t.sectionId, t])),
    [data],
  );

  const seatedTotal = selected.reduce((acc, seat) => {
    const ticket = ticketBySection.get(seat.sectionId);
    return acc + (ticket ? ticket.price + ticket.fee : 0);
  }, 0);

  const generalTotal = Object.entries(generalQty).reduce((acc, [ticketId, qty]) => {
    const ticket = (data?.tickets ?? []).find((t) => t.id === ticketId);
    return acc + (ticket ? (ticket.price + ticket.fee) * qty : 0);
  }, 0);

  const totalCount = selected.length + Object.values(generalQty).reduce((a, b) => a + b, 0);

  function toggleSeat(seat: MapSeat) {
    setError(null);
    setSelected((prev) => {
      const exists = prev.find((s) => s.id === seat.id);
      if (exists) return prev.filter((s) => s.id !== seat.id);
      if (prev.length >= 8) return prev;
      return [...prev, seat];
    });
  }

  async function confirm() {
    if (!data || !eventId || totalCount === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Reserva exclusiva por 10 min en inventory (butacas y sectores generales).
      const seatedByType = new Map<string, string[]>();
      for (const seat of selected) {
        const ticket = ticketBySection.get(seat.sectionId);
        if (ticket) seatedByType.set(ticket.id, [...(seatedByType.get(ticket.id) ?? []), seat.id]);
      }
      const result = await reserveTickets({
        data: {
          eventId,
          eventDateId: dateId,
          seated: [...seatedByType].map(([ticketTypeId, seatIds]) => ({ ticketTypeId, seatIds })),
          general: Object.entries(generalQty)
            .filter(([, qty]) => qty > 0)
            .map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })),
        },
      });
      if (!result.ok) {
        setError(
          result.reason === "SEAT_TAKEN"
            ? "Algunas butacas fueron tomadas por otra persona. Revisa el mapa e intenta de nuevo."
            : result.message,
        );
        if (result.conflicts.length > 0) {
          setSelected((prev) => prev.filter((s) => !result.conflicts.some((c) => c.includes(s.id))));
        }
        await mapQuery.refetch();
        setBusy(false);
        return;
      }
      setHoldUntil(new Date(result.expiresAt).getTime());

      // Una línea del carro por reserva (respaldada por inventory durante 10 minutos).
      const eventInfo = data.date.event;
      const items: CartItem[] = [];
      for (const reservation of result.reservations) {
        const ticket = (data.tickets ?? []).find((t) => t.id === reservation.ticketTypeId);
        const section = data.sections.find((s) => s.id === ticket?.sectionId);
        if (!ticket || !eventInfo) continue;
        const seats = reservation.seatIds
          .map((id) => data.seats.find((seat) => seat.id === id))
          .filter((seat) => seat !== undefined)
          .map((seat) => `${seat.row}${seat.number}`);
        items.push({
          key: `res:${reservation.id}`,
          kind: "ticket_type",
          itemId: ticket.id,
          reservationId: reservation.id,
          eventId: eventInfo.id,
          eventSlug: eventInfo.slug,
          eventTitle: eventInfo.title,
          eventDateId: dateId,
          startsAt: data.date.startsAt,
          venueName: data.date.venue?.name ?? "",
          sectionName: section?.name ?? ticket.name,
          seatLabel: seats.length > 0 ? `Butacas ${seats.join(", ")}`.slice(0, 80) : null,
          quantity: reservation.quantity,
          unitPrice: ticket.price,
          unitFee: ticket.fee,
        });
      }

      await addToCart(items, dateId);
      void navigate({ to: "/carro" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "No pudimos reservar tus asientos");
    } finally {
      setBusy(false);
    }
  }

  if (mapQuery.isLoading) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
          <MetaText>Cargando mapa de asientos…</MetaText>
        </div>
      </PublicLayout>
    );
  }

  if (mapQuery.isError || !data) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8" role="alert">
          <SectionTitle>No pudimos cargar esta función</SectionTitle>
          <MetaText className="mt-3">Vuelve a la cartelera e intenta nuevamente.</MetaText>
        </div>
      </PublicLayout>
    );
  }

  if (queue && queue.state !== "active") {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 md:px-8">
          <QueuePanel view={queue} eventTitle={data.date.event?.title ?? ""} />
        </div>
      </PublicLayout>
    );
  }

  const seatedSections = data.sections.filter((s) => s.kind === "seated");
  const generalSections = data.sections.filter((s) => s.kind === "general");

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[1240px] px-5 py-12 md:px-8 md:py-16">
        <Caption className="text-graphite">Selecciona tus asientos</Caption>
        <DisplayHeading className="mt-4">{data.date.event?.title}</DisplayHeading>
        <MetaText className="mt-3">
          {dateAndTime(data.date.startsAt)} · {data.date.venue?.name}, {data.date.venue?.city}
        </MetaText>

        {queue?.expiresAt ? (
          <div className="mt-6 inline-flex items-center gap-3 rounded-pill bg-ember/15 px-4 py-2">
            <span className="size-2 rounded-pill bg-ember" aria-hidden />
            <MetaText className="inline text-carbon">
              Ventana de compra: {countdown(new Date(queue.expiresAt).getTime() - now)}
            </MetaText>
          </div>
        ) : null}

        <Hairline className="mt-10" />

        <div className="mt-10 grid gap-12 lg:grid-cols-[1.6fr_1fr] lg:items-start">
          <div className="grid gap-10">
            {seatedSections.length > 0 ? (
              <SeatMap
                sections={data.sections}
                seats={data.seats}
                tickets={data.tickets}
                width={data.date.venue?.map_width ?? 1000}
                height={data.date.venue?.map_height ?? 700}
                selected={selected.map((s) => s.id)}
                onToggleSeat={toggleSeat}
              />
            ) : null}

            {generalSections.length > 0 ? (
              <div className="grid gap-6">
                <SectionTitle>Sectores sin numerar</SectionTitle>
                {generalSections.map((section) => {
                  const ticket = ticketBySection.get(section.id);
                  if (!ticket) return null;
                  const remaining = Math.max(0, ticket.capacity - ticket.sold);
                  const qty = generalQty[ticket.id] ?? 0;
                  return (
                    <div
                      key={section.id}
                      className="flex flex-wrap items-center justify-between gap-6 border-b border-ash pb-6"
                    >
                      <div className="grid gap-1">
                        <span className="text-subheading">{section.name}</span>
                        <MetaText>
                          {money(ticket.price)} + {money(ticket.fee)} cargo · {remaining} disponibles
                        </MetaText>
                      </div>
                      <div className="flex items-center gap-4">
                        <GhostButton
                          arrow={false}
                          aria-label={`Quitar ticket ${section.name}`}
                          onClick={() =>
                            setGeneralQty((prev) => ({
                              ...prev,
                              [ticket.id]: Math.max(0, (prev[ticket.id] ?? 0) - 1),
                            }))
                          }
                        >
                          −
                        </GhostButton>
                        <span className="w-6 text-center text-body">{qty}</span>
                        <GhostButton
                          arrow={false}
                          aria-label={`Agregar ticket ${section.name}`}
                          onClick={() =>
                            setGeneralQty((prev) => ({
                              ...prev,
                              [ticket.id]: Math.min(
                                Math.min(8, remaining),
                                (prev[ticket.id] ?? 0) + 1,
                              ),
                            }))
                          }
                        >
                          +
                        </GhostButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          <aside className="grid gap-6 rounded-card bg-plaster p-7 lg:sticky lg:top-28">
            <SectionTitle>Tu selección</SectionTitle>

            {totalCount === 0 ? (
              <MetaText>Aún no has elegido tickets.</MetaText>
            ) : (
              <div className="grid gap-3">
                {selected.map((seat) => {
                  const ticket = ticketBySection.get(seat.sectionId);
                  const section = data.sections.find((s) => s.id === seat.sectionId);
                  return (
                    <div key={seat.id} className="flex items-baseline justify-between gap-4">
                      <span className="text-body">
                        {section?.name} · Fila {seat.row}, {seat.number}
                      </span>
                      <MetaText className="inline">
                        {money((ticket?.price ?? 0) + (ticket?.fee ?? 0))}
                      </MetaText>
                    </div>
                  );
                })}
                {Object.entries(generalQty)
                  .filter(([, qty]) => qty > 0)
                  .map(([ticketId, qty]) => {
                    const ticket = data.tickets.find((t) => t.id === ticketId);
                    const section = data.sections.find((s) => s.id === ticket?.sectionId);
                    return (
                      <div key={ticketId} className="flex items-baseline justify-between gap-4">
                        <span className="text-body">
                          {section?.name} × {qty}
                        </span>
                        <MetaText className="inline">
                          {money(((ticket?.price ?? 0) + (ticket?.fee ?? 0)) * qty)}
                        </MetaText>
                      </div>
                    );
                  })}
              </div>
            )}

            <Hairline />
            <div className="flex items-baseline justify-between">
              <span className="text-body">Total con cargos</span>
              <span className="text-subheading">{money(seatedTotal + generalTotal)}</span>
            </div>

            {holdUntil ? (
              <MetaText>Reserva vigente por {countdown(holdUntil - now)}</MetaText>
            ) : (
              <MetaText>Al continuar reservamos tus butacas por 10 minutos.</MetaText>
            )}

            {error ? (
              <p role="alert" className="text-body text-ember">
                {error}
              </p>
            ) : null}

            <PillButton onClick={() => void confirm()} disabled={busy || totalCount === 0}>
              {busy ? "Reservando…" : "Continuar al carro"}
            </PillButton>
          </aside>
        </div>
      </div>
    </PublicLayout>
  );
}
