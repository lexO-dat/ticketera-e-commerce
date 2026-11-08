import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton } from "@/components/kit/PillButton";
import { Field, Select, TextInput } from "@/components/kit/Field";
import { ORDER_STATUS_LABELS } from "@/lib/account.functions";
import { adminOrders, adminRefundOrder } from "@/lib/admin.functions";
import type { ApiOrder } from "@/lib/orders.functions";
import { money, shortDate } from "@/lib/format";

export const Route = createFileRoute("/admin/ordenes")({
  component: AdminOrdersPage,
});

const STATUSES = Object.keys(ORDER_STATUS_LABELS) as ApiOrder["status"][];

/**
 * Órdenes (orders). El estado lo mueve la saga de compra, nunca a mano: lo único que un admin
 * puede hacer es reembolsar una orden confirmada (payments devuelve el dinero e inventory el cupo).
 */
function AdminOrdersPage() {
  const qc = useQueryClient();
  const orders = useQuery({ queryKey: ["admin", "orders"], queryFn: () => adminOrders() });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refund = useMutation({
    mutationFn: (id: string) => adminRefundOrder({ data: { id } }),
    onSuccess: () => {
      setMessage(
        "Reembolso solicitado: la orden pasa a Reembolsada cuando el adquirente confirme.",
      );
      void qc.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const term = query.trim().toLowerCase();
  const visible = (orders.data ?? []).filter((order) => {
    const matchesStatus = !status || order.status === status;
    const matchesTerm =
      !term ||
      order.orderCode.toLowerCase().includes(term) ||
      order.buyer.email.toLowerCase().includes(term) ||
      order.buyer.name.toLowerCase().includes(term);
    return matchesStatus && matchesTerm;
  });

  return (
    <div className="grid gap-10">
      <div>
        <Caption className="text-graphite">Ventas</Caption>
        <DisplayHeading className="mt-3">Órdenes</DisplayHeading>
      </div>

      <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
        <Field label="Buscar">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Código, email o nombre"
          />
        </Field>
        <Field label="Estado">
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {ORDER_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {message ? <MetaText>{message}</MetaText> : null}

      <section className="grid gap-4">
        <SectionTitle>{visible.length} órdenes</SectionTitle>
        <Hairline />
        {orders.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {visible.map((order) => (
          <div key={order.id} className="grid gap-3 border-b border-ash pb-5">
            <div className="flex flex-wrap items-center gap-4">
              <span className="font-roboto text-body tracking-[0.06em]">{order.orderCode}</span>
              <MetaText className="inline">
                {order.buyer.name} · {order.buyer.email}
              </MetaText>
              <MetaText className="inline">{shortDate(order.createdAt)}</MetaText>
              <span className="text-body">{money(Number(order.total))}</span>
              <MetaText className="inline">
                {ORDER_STATUS_LABELS[order.status]}
                {order.cancelReason ? ` (${order.cancelReason})` : ""}
              </MetaText>
              {order.status === "CONFIRMED" ? (
                <GhostButton
                  arrow={false}
                  disabled={refund.isPending}
                  onClick={() => {
                    if (
                      confirm(
                        `¿Reembolsar ${money(Number(order.total))} de la orden ${order.orderCode}?`,
                      )
                    )
                      refund.mutate(order.id);
                  }}
                >
                  <span className="text-ember underline">Reembolsar</span>
                </GhostButton>
              ) : null}
            </div>
            <GhostButton
              arrow={false}
              onClick={() => setOpenId(openId === order.id ? null : order.id)}
            >
              <span className="underline">
                {openId === order.id ? "Ocultar detalle" : "Ver detalle"}
              </span>
            </GhostButton>
            {openId === order.id ? (
              <div className="grid gap-2 rounded-card bg-plaster p-5">
                {order.lines.map((line) => (
                  <MetaText key={line.id}>
                    {line.name} × {line.quantity} ·{" "}
                    {money(Number(line.unitPrice) + Number(line.unitFee))} c/u
                    {line.seatIds.length > 0 ? ` · ${line.seatIds.length} butaca(s)` : ""}
                  </MetaText>
                ))}
                <Hairline />
                <MetaText>Subtotal {money(Number(order.subtotal))}</MetaText>
                <MetaText>Cargos {money(Number(order.fees))}</MetaText>
                <MetaText>
                  Descuento {money(Number(order.discount))}
                  {order.promoCode ? ` (${order.promoCode})` : ""}
                </MetaText>
                <MetaText>Pago {order.paymentId ?? "—"}</MetaText>
              </div>
            ) : null}
          </div>
        ))}
      </section>
    </div>
  );
}
