import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillLink } from "@/components/kit/PillButton";
import { ORDER_STATUS_LABELS, myOrders, type MyOrder } from "@/lib/account.functions";
import { refreshAuth, useAuth } from "@/lib/useAuth";
import { signOut } from "@/lib/auth.functions";
import { dateAndTime, money } from "@/lib/format";

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

  const ordersQuery = useQuery({
    queryKey: ["my-orders", session?.user.id],
    queryFn: () => myOrders(),
    enabled: Boolean(session),
  });

  const orders = ordersQuery.data ?? [];
  const now = Date.now();
  const upcoming = orders.filter((o) => o.items.some((i) => new Date(i.startsAt).getTime() >= now));
  const past = orders.filter((o) => !o.items.some((i) => new Date(i.startsAt).getTime() >= now));

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

        {loading || ordersQuery.isLoading ? (
          <MetaText className="mt-12">Cargando tus tickets…</MetaText>
        ) : orders.length === 0 ? (
          <div className="mt-14 grid justify-items-start gap-6">
            <SectionTitle>Todavía no tienes compras</SectionTitle>
            <MetaText>Cuando compres tickets aparecerán acá con sus códigos digitales.</MetaText>
            <PillLink to="/eventos" search={{}}>
              Ver cartelera
            </PillLink>
          </div>
        ) : (
          <>
            <OrderGroup
              title="Próximos shows"
              orders={upcoming}
              empty="No tienes shows próximos."
            />
            <OrderGroup
              title="Eventos pasados"
              orders={past}
              empty="Aún no tienes eventos pasados."
            />
          </>
        )}
      </div>
    </PublicLayout>
  );
}

function OrderGroup({ title, orders, empty }: { title: string; orders: MyOrder[]; empty: string }) {
  return (
    <section className="mt-16">
      <SectionTitle>{title}</SectionTitle>
      <Hairline className="mt-6" />
      {orders.length === 0 ? (
        <MetaText className="mt-6">{empty}</MetaText>
      ) : (
        <div className="grid gap-10 pt-8">
          {orders.map((order) => (
            <article key={order.id} className="grid gap-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <span className="text-subheading">Orden {order.orderCode}</span>
                <MetaText className="inline">
                  {money(order.total)} · {ORDER_STATUS_LABELS[order.status]}
                </MetaText>
              </div>

              <div className="grid gap-6">
                {order.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid gap-4 border-t border-ash pt-6 sm:grid-cols-[160px_1fr]"
                  >
                    <div className="aspect-[4/3] overflow-hidden rounded-card bg-plaster">
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.eventTitle}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : null}
                    </div>
                    <div className="grid gap-2">
                      <span className="text-lead">{item.eventTitle}</span>
                      <MetaText>
                        {dateAndTime(item.startsAt)} · {item.venue}
                      </MetaText>
                      <MetaText>
                        {item.ticketName} × {item.quantity}
                        {item.seatLabel ? ` · ${item.seatLabel}` : ""}
                      </MetaText>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {item.tickets.map((ticket) => (
                          <span
                            key={ticket.id}
                            className="rounded-button bg-plaster px-3 py-1 font-roboto text-micro tracking-[0.1em]"
                          >
                            {ticket.ticketCode}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <PillLink
                to="/orden/$code"
                params={{ code: order.orderCode }}
                className="justify-self-start"
              >
                Ver orden completa
              </PillLink>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
