import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton } from "@/components/kit/PillButton";
import { Field, Select, TextInput } from "@/components/kit/Field";
import { adminOrders, adminUpdateOrderStatus } from "@/lib/admin.functions";
import { dateAndTime, money, shortDate } from "@/lib/format";

export const Route = createFileRoute("/admin/ordenes")({
  component: AdminOrdersPage,
});

const STATUS = ["pending", "paid", "refunded", "cancelled"] as const;
const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  paid: "Pagada",
  refunded: "Reembolsada",
  cancelled: "Anulada",
};

function AdminOrdersPage() {
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ["admin", "orders"], queryFn: () => adminOrders() });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: (input: { id: string; status: (typeof STATUS)[number] }) =>
      adminUpdateOrderStatus({ data: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  const list = (orders.data ?? []).filter((order) => {
    const matchesStatus = !status || order.status === status;
    const term = query.trim().toLowerCase();
    const matchesTerm =
      !term ||
      order.order_code.toLowerCase().includes(term) ||
      order.buyer_email.toLowerCase().includes(term) ||
      order.buyer_name.toLowerCase().includes(term);
    return matchesStatus && matchesTerm;
  });

  return (
    <div className="grid gap-10">
      <div>
        <Caption className="text-graphite">Ventas</Caption>
        <DisplayHeading className="mt-3">Órdenes</DisplayHeading>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Field label="Buscar">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Código, nombre o email"
          />
        </Field>
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {STATUS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Hairline />
      <MetaText>{list.length} órdenes</MetaText>

      <div className="grid gap-4">
        {orders.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {list.map((order) => (
          <div key={order.id} className="grid gap-3 border-b border-ash pb-5">
            <div className="grid gap-3 md:grid-cols-[auto_1fr_auto_auto_auto] md:items-center md:gap-6">
              <span className="font-roboto text-body tracking-[0.06em]">{order.order_code}</span>
              <MetaText>
                {order.buyer_name} · {order.buyer_email}
              </MetaText>
              <MetaText className="inline">{shortDate(order.created_at)}</MetaText>
              <span className="text-body">{money(Number(order.total))}</span>
              <Select
                className="max-w-[170px]"
                value={order.status}
                onChange={(e) =>
                  update.mutate({ id: order.id, status: e.target.value as (typeof STATUS)[number] })
                }
              >
                {STATUS.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>

            <GhostButton arrow={false} onClick={() => setOpenId(openId === order.id ? null : order.id)}>
              <span className="text-graphite underline">
                {openId === order.id ? "Ocultar detalle" : "Ver detalle y tickets"}
              </span>
            </GhostButton>

            {openId === order.id ? (
              <div className="grid gap-5 rounded-card bg-plaster p-6">
                <SectionTitle>Detalle</SectionTitle>
                <div className="grid gap-2">
                  {(order.order_items ?? []).map((item) => (
                    <MetaText key={item.id}>
                      {item.event_dates?.events?.title} · {dateAndTime(item.event_dates?.starts_at ?? "")}{" "}
                      · {item.ticket_types?.name} × {item.quantity} ·{" "}
                      {money(Number(item.unit_price) + Number(item.unit_fee))} c/u
                    </MetaText>
                  ))}
                </div>
                <div className="grid gap-2">
                  <MetaText>Tickets emitidos</MetaText>
                  <div className="flex flex-wrap gap-3">
                    {(order.tickets ?? []).map((ticket) => (
                      <span
                        key={ticket.id}
                        className="rounded-pill bg-paper px-4 py-1 font-roboto text-micro tracking-[0.08em]"
                      >
                        {ticket.ticket_code}
                        {ticket.checked_in_at ? " · usado" : ""}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="grid gap-1">
                  <MetaText>Subtotal {money(Number(order.subtotal))}</MetaText>
                  <MetaText>Cargos {money(Number(order.fees))}</MetaText>
                  <MetaText>
                    Descuento {money(Number(order.discount))}
                    {order.promo_code ? ` (${order.promo_code})` : ""}
                  </MetaText>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
