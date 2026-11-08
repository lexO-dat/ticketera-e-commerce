import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, Hairline, MetaText } from "@/components/kit/Text";
import { PillButton } from "@/components/kit/PillButton";
import { Field, TextInput } from "@/components/kit/Field";
import { requestPasswordReset, signIn, signUp, type PublicSessionUser } from "@/lib/auth.functions";
import { refreshAuth } from "@/lib/useAuth";

const searchSchema = z.object({
  redirect: z.string().optional(),
  mode: z.enum(["login", "signup", "forgot"]).optional(),
});

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (search) => searchSchema.parse(search),
  head: () => ({
    meta: [
      { title: "Ingresa a tu cuenta — Ticketera" },
      {
        name: "description",
        content:
          "Inicia sesión o crea tu cuenta para comprar tickets, ver tus entradas y revisar tus eventos pasados.",
      },
      { property: "og:title", content: "Ingresa a tu cuenta — Ticketera" },
      {
        property: "og:description",
        content: "Cuenta Ticketera: compra tickets y accede a tus entradas digitales.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [mode, setMode] = useState<"login" | "signup" | "forgot">(search.mode ?? "login");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function land(user: PublicSessionUser) {
    if (user.isAdmin) {
      void navigate({ to: "/admin" });
      return;
    }
    if (search.redirect) {
      void navigate({ to: search.redirect as "/" });
      return;
    }
    void navigate({ to: "/mi-cuenta" });
  }

  useEffect(() => {
    void refreshAuth().then((state) => {
      if (state.session) land(state.session.user);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "forgot") {
        await requestPasswordReset({ data: { email: form.email.trim() } });
        setNotice(
          "Si existe una cuenta con ese email, te enviamos un enlace para restablecer la contraseña.",
        );
        return;
      }
      if (mode === "signup") {
        await signUp({
          data: { email: form.email.trim(), password: form.password, fullName: form.name.trim() },
        });
      }
      const user = await signIn({ data: { email: form.email.trim(), password: form.password } });
      await refreshAuth();
      land(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la solicitud.");
    } finally {
      setBusy(false);
    }
  }

  const title =
    mode === "login"
      ? "Iniciar sesión"
      : mode === "signup"
        ? "Crear cuenta"
        : "Recuperar contraseña";

  return (
    <PublicLayout>
      <div className="mx-auto max-w-[520px] px-5 py-20 md:px-8 md:py-28">
        <Caption className="text-graphite">Tu cuenta</Caption>
        <DisplayHeading className="mt-4">{title}</DisplayHeading>
        <MetaText className="mt-4">
          Necesitas una cuenta para comprar tickets y para acceder a tus entradas digitales, eventos
          próximos e historial de compras.
        </MetaText>

        <form className="mt-10 grid gap-6" onSubmit={(e) => void submit(e)}>
          {mode === "signup" ? (
            <Field label="Nombre completo">
              <TextInput
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                autoComplete="name"
                placeholder="Camila Rivas"
              />
            </Field>
          ) : null}
          <Field label="Email">
            <TextInput
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              autoComplete="email"
            />
          </Field>
          {mode !== "forgot" ? (
            <Field label="Contraseña">
              <TextInput
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
            </Field>
          ) : null}
          {mode === "signup" ? (
            <MetaText>
              Usa al menos 10 caracteres; una frase fácil de recordar funciona bien.
            </MetaText>
          ) : null}
          {error ? (
            <p role="alert" className="text-body text-ember">
              {error}
            </p>
          ) : null}
          {notice ? <MetaText>{notice}</MetaText> : null}
          <PillButton type="submit" disabled={busy}>
            {busy
              ? "Procesando…"
              : mode === "login"
                ? "Ingresar"
                : mode === "signup"
                  ? "Crear mi cuenta"
                  : "Enviar enlace"}
          </PillButton>
        </form>

        <Hairline className="mt-10 bg-ash" />
        <button
          type="button"
          className="mt-6 text-body text-carbon underline underline-offset-4"
          onClick={() => {
            setError(null);
            setNotice(null);
            setMode(mode === "login" ? "signup" : "login");
          }}
        >
          {mode === "login" ? "No tengo cuenta, quiero registrarme" : "Ya tengo cuenta, ingresar"}
        </button>
        {mode === "login" ? (
          <button
            type="button"
            className="mt-4 block text-body text-graphite underline underline-offset-4"
            onClick={() => {
              setError(null);
              setNotice(null);
              setMode("forgot");
            }}
          >
            Olvidé mi contraseña
          </button>
        ) : null}
        <MetaText className="mt-6">
          El equipo interno usa este mismo acceso y entra directo al{" "}
          <Link to="/admin" className="underline">
            panel de administración
          </Link>
          .
        </MetaText>
      </div>
    </PublicLayout>
  );
}
