import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Caption, DisplayHeading, Hairline, MetaText, SectionTitle } from "@/components/kit/Text";
import { GhostButton, PillButton } from "@/components/kit/PillButton";
import { Field, TextInput } from "@/components/kit/Field";
import { adminCreateStaff, adminRemoveStaff, adminStaff } from "@/lib/admin.functions";
import { shortDate } from "@/lib/format";

export const Route = createFileRoute("/admin/equipo")({
  component: AdminStaffPage,
});

function AdminStaffPage() {
  const qc = useQueryClient();
  const staff = useQuery({ queryKey: ["admin", "staff"], queryFn: () => adminStaff() });
  const [form, setForm] = useState({ email: "", password: "", fullName: "" });
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin"] });
  };

  const create = useMutation({
    mutationFn: () =>
      adminCreateStaff({
        data: {
          email: form.email,
          password: form.password,
          fullName: form.fullName || undefined,
          role: "admin",
        },
      }),
    onSuccess: () => {
      setForm({ email: "", password: "", fullName: "" });
      setMessage("Usuario administrador creado");
      refresh();
    },
    onError: (e: Error) => setMessage(e.message),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => adminRemoveStaff({ data: { userId, role: "admin" } }),
    onSuccess: refresh,
    onError: (e: Error) => setMessage(e.message),
  });

  return (
    <div className="grid gap-10">
      <div>
        <Caption className="text-graphite">Accesos</Caption>
        <DisplayHeading className="mt-3">Equipo</DisplayHeading>
        <MetaText className="mt-4">
          No existe registro público: las cuentas del panel se crean solamente desde aquí.
        </MetaText>
      </div>

      <section className="grid gap-6 rounded-card bg-plaster p-7">
        <SectionTitle>Nuevo administrador</SectionTitle>
        <div className="grid gap-6 md:grid-cols-3">
          <Field label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Contraseña temporal">
            <TextInput
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="Nombre">
            <TextInput
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <PillButton
            onClick={() => create.mutate()}
            disabled={create.isPending || form.password.length < 5 || !form.email.includes("@")}
          >
            Crear acceso
          </PillButton>
          {message ? <MetaText className="inline">{message}</MetaText> : null}
        </div>
      </section>

      <section className="grid gap-4">
        <SectionTitle>Administradores actuales</SectionTitle>
        <Hairline />
        {staff.isLoading ? <MetaText>Cargando…</MetaText> : null}
        {(staff.data ?? []).map((member) => (
          <div
            key={member.userId}
            className="grid gap-3 border-b border-ash pb-4 md:grid-cols-[1fr_auto_auto] md:items-center md:gap-6"
          >
            <div className="grid gap-1">
              <span className="text-body">{member.email}</span>
              <MetaText>
                {member.fullName ?? "Sin nombre"} ·{" "}
                {member.lastSignInAt ? `último ingreso ${shortDate(member.lastSignInAt)}` : "sin ingresos"}
              </MetaText>
            </div>
            <MetaText className="inline">{member.role}</MetaText>
            <GhostButton
              arrow={false}
              onClick={() => {
                if (confirm(`¿Quitar acceso de administrador a ${member.email}?`))
                  remove.mutate(member.userId);
              }}
            >
              <span className="text-ember underline">Quitar acceso</span>
            </GhostButton>
          </div>
        ))}
      </section>
    </div>
  );
}
