import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, MetaText } from "@/components/kit/Text";
import { PillButton, PillLink } from "@/components/kit/PillButton";
import { Field, TextInput } from "@/components/kit/Field";
import { resetPassword } from "@/lib/auth.functions";

export const Route = createFileRoute("/restablecer-contrasena")({
  ssr: false,
  validateSearch: (search) => z.object({ token: z.string().optional() }).parse(search),
  head: () => ({
    meta: [{ title: "Restablecer contraseña — Ticketera" }, { name: "robots", content: "noindex" }],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { token } = Route.useSearch();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "El enlace no es válido.");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) return;
    if (password !== confirm) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resetPassword({ data: { token, newPassword: password } });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo restablecer la contraseña.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[520px] px-5 py-20 md:px-8 md:py-28">
        <Caption className="text-graphite">Tu cuenta</Caption>
        <DisplayHeading className="mt-4">
          {done ? "Contraseña actualizada" : "Nueva contraseña"}
        </DisplayHeading>
        {done ? (
          <>
            <MetaText className="mt-4">
              Cerramos tus sesiones abiertas por seguridad. Ingresa con tu nueva contraseña.
            </MetaText>
            <div className="mt-8">
              <PillLink to="/auth">Iniciar sesión</PillLink>
            </div>
          </>
        ) : (
          <form className="mt-10 grid gap-6" onSubmit={(e) => void submit(e)}>
            <Field label="Nueva contraseña">
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Repite la contraseña">
              <TextInput
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <MetaText>
              Usa al menos 10 caracteres; una frase fácil de recordar funciona bien.
            </MetaText>
            {error ? (
              <p role="alert" className="text-body text-ember">
                {error}
              </p>
            ) : null}
            <PillButton type="submit" disabled={busy || !token}>
              {busy ? "Guardando…" : "Guardar contraseña"}
            </PillButton>
          </form>
        )}
      </div>
    </PublicLayout>
  );
}
