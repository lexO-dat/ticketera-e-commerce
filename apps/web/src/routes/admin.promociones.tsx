import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillButton } from "@/components/kit/PillButton";
import { Field, Select, TextInput } from "@/components/kit/Field";
import { adminDeletePromo, adminPromos, adminSavePromo } from "@/lib/admin.functions";
import { shortDate } from "@/lib/format";

export const Route = createFileRoute("/admin/promociones")({
  component: AdminPromosPage,
});

const empty = {
  id: null as string | null,
  code: "",
  percentOff: 10,
  maxUses: 100,
  validUntil: "",
  active: true,
};

function AdminPromosPage() {
  const qc = useQueryClient();
  const promos = useQuery({ queryKey: ["admin", "promos"], queryFn: () => adminPromos() });
  const [form, setForm] = useState(empty);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
  };

  const save = useMutation({
    mutationFn: () =>
      adminSavePromo({
        data: {
          id: form.id,
          code: form.code,
          percentOff: form.percentOff,
          maxUses: form.maxUses,
          validUntil: form.validUntil || null,
          active: form.active,
        },
      }),
    onSuccess: () => {
      setForm(empty);
      setMessage("Código guardado");
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => adminDeletePromo({ data: { id } }),
    onSuccess: refresh,
  });

  return (
    <div className="grid gap-10">
      <div>
        <Caption className="text-graphite">Marketing</Caption>
        <DisplayHeading className="mt-3">Promociones</DisplayHeading>
      </div>

      <section className="grid gap-6 rounded-card bg-plaster p-7">
        <SectionTitle>{form.id ? "Editar código" : "Nuevo código"}</SectionTitle>
        <div className="grid gap-6 md:grid-cols-5">
          <Field label="Código">
            <TextInput
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="% descuento">
            <TextInput
              type="number"
              value={form.percentOff}
              onChange={(e) => setForm({ ...form, percentOff: Number(e.target.value) })}
            />
          </Field>
          <Field label="Usos máximos">
            <TextInput
              type="number"
              value={form.maxUses}
              onChange={(e) => setForm({ ...form, maxUses: Number(e.target.value) })}
            />
          </Field>
          <Field label="Vigente hasta">
            <TextInput
              type="date"
              value={form.validUntil}
              onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
            />
          </Field>
          <Field label="Activo">
            <Select
              value={form.active ? "yes" : "no"}
              onChange={(e) => setForm({ ...form, active: e.target.value === "yes" })}
            >
              <option value="yes">Sí</option>
              <option value="no">No</option>
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <PillButton
            onClick={() => save.mutate()}
            disabled={save.isPending || form.code.length < 2}
          >
            Guardar código
          </PillButton>
          {form.id ? <GhostButton onClick={() => setForm(empty)}>Cancelar</GhostButton> : null}
          {message ? <MetaText className="inline">{message}</MetaText> : null}
        </div>
      </section>

      <section className="grid gap-4">
        <SectionTitle>Códigos existentes</SectionTitle>
        <Hairline />
        {promos.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {(promos.data ?? []).map((promo) => (
          <div
            key={promo.id}
            className="grid gap-3 border-b border-ash pb-4 md:grid-cols-[auto_auto_1fr_auto_auto] md:items-center md:gap-6"
          >
            <span className="font-roboto text-body tracking-[0.08em]">{promo.code}</span>
            <span className="text-body">{promo.percent_off}%</span>
            <MetaText>
              {promo.used_count}/{promo.max_uses} usos ·{" "}
              {promo.valid_until ? `vence ${shortDate(promo.valid_until)}` : "sin vencimiento"} ·{" "}
              {promo.active ? "activo" : "inactivo"}
            </MetaText>
            <GhostButton
              arrow={false}
              onClick={() =>
                setForm({
                  id: promo.id,
                  code: promo.code,
                  percentOff: promo.percent_off,
                  maxUses: promo.max_uses,
                  validUntil: promo.valid_until ? promo.valid_until.slice(0, 10) : "",
                  active: promo.active,
                })
              }
            >
              <span className="underline">Editar</span>
            </GhostButton>
            <GhostButton
              arrow={false}
              onClick={() => {
                if (confirm(`¿Eliminar el código ${promo.code}?`)) remove.mutate(promo.id);
              }}
            >
              <span className="text-ember underline">Eliminar</span>
            </GhostButton>
          </div>
        ))}
      </section>
    </div>
  );
}
