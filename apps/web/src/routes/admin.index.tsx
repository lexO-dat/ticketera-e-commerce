import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { adminOverview } from "@/lib/admin.functions";
import { money, plainNumber, shortDate } from "@/lib/format";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

function AdminDashboard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => adminOverview(),
  });

  if (isLoading) return <MetaText>Cargando métricas…</MetaText>;
  if (isError || !data)
    return (
      <p role="alert" className="text-body text-ember">
        {error instanceof Error ? error.message : "No pudimos cargar el dashboard"}
      </p>
    );

  const maxRevenue = Math.max(1, ...data.series.map((d) => d.revenue));

  return (
    <div className="grid gap-12">
      <div>
        <Caption className="text-graphite">Resumen general</Caption>
        <DisplayHeading className="mt-3">Dashboard</DisplayHeading>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Ingresos" value={money(data.kpis.revenue)} />
        <Kpi label="Órdenes pagadas" value={plainNumber(data.kpis.orders)} />
        <Kpi label="Tickets vendidos" value={plainNumber(data.kpis.ticketsSold)} />
        <Kpi
          label="Ocupación"
          value={`${Math.round(data.kpis.occupancy * 100)}%`}
          hint={`${plainNumber(data.kpis.capacity)} lugares publicados`}
        />
        <Kpi label="Ticket promedio" value={money(data.kpis.avgTicket)} />
        <Kpi label="Eventos publicados" value={plainNumber(data.kpis.publishedEvents)} />
        <Kpi label="En fila virtual" value={plainNumber(data.queueCounts["waiting"] ?? 0)} />
        <Kpi label="Comprando ahora" value={plainNumber(data.queueCounts["active"] ?? 0)} />
      </div>

      <section className="grid gap-6">
        <SectionTitle>Ingresos últimos días</SectionTitle>
        <div className="flex h-48 items-end gap-2 rounded-card bg-plaster p-6">
          {data.series.length === 0 ? (
            <MetaText>Sin ventas registradas todavía.</MetaText>
          ) : (
            data.series.map((day) => (
              <div key={day.date} className="flex flex-1 flex-col items-center gap-2">
                <div
                  className="w-full bg-sage"
                  style={{ height: `${Math.max(4, (day.revenue / maxRevenue) * 120)}px` }}
                  title={`${day.date}: ${money(day.revenue)}`}
                />
                <span className="font-roboto text-micro text-graphite">
                  {day.date.slice(8, 10)}/{day.date.slice(5, 7)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="grid gap-4">
          <SectionTitle>Embudo de conversión</SectionTitle>
          {(["view", "add_to_cart", "checkout", "purchase"] as const).map((step) => {
            const label = {
              view: "Vistas de evento",
              add_to_cart: "Agregados al carro",
              checkout: "Checkouts iniciados",
              purchase: "Compras",
            }[step];
            const total = Math.max(1, data.funnel["view"] ?? 0);
            const value = data.funnel[step] ?? 0;
            return (
              <div key={step} className="grid gap-2">
                <div className="flex items-baseline justify-between">
                  <MetaText className="inline">{label}</MetaText>
                  <span className="text-body">{plainNumber(value)}</span>
                </div>
                <div className="h-1 w-full bg-linen">
                  <div
                    className="h-1 bg-carbon"
                    style={{ width: `${Math.min(100, (value / total) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid gap-4">
          <SectionTitle>Eventos con mejor desempeño</SectionTitle>
          <Hairline />
          {data.topEvents.map((event) => (
            <div
              key={event.id}
              className="flex items-baseline justify-between gap-6 border-b border-ash pb-3"
            >
              <div className="grid gap-1">
                <span className="text-body">{event.title}</span>
                <MetaText>
                  {event.status} · {plainNumber(event.views)} vistas
                </MetaText>
              </div>
              <span className="text-body">{money(event.revenue)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4">
        <SectionTitle>Últimas órdenes</SectionTitle>
        <Hairline />
        {data.recentOrders.map((order) => (
          <div
            key={order.id}
            className="grid gap-2 border-b border-ash pb-3 md:grid-cols-[auto_1fr_auto_auto] md:items-center md:gap-6"
          >
            <span className="font-roboto text-body tracking-[0.06em]">{order.order_code}</span>
            <MetaText>
              {order.buyer_name} · {order.buyer_email}
            </MetaText>
            <MetaText className="inline">{shortDate(order.created_at)}</MetaText>
            <span className="text-body md:justify-self-end">{money(Number(order.total))}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid gap-2 rounded-card bg-plaster p-6">
      <Caption className="text-graphite">{label}</Caption>
      <span className="text-subheading">{value}</span>
      {hint ? <MetaText>{hint}</MetaText> : null}
    </div>
  );
}
