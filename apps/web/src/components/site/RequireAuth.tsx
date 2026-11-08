import { useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { PublicLayout } from "@/components/site/PublicLayout";
import { Caption, DisplayHeading, MetaText } from "@/components/kit/Text";
import { PillLink } from "@/components/kit/PillButton";
import { useAuth } from "@/lib/useAuth";

/** Comprar requiere cuenta: muestra el muro de acceso y vuelve al flujo tras ingresar. */
export function RequireAuth({ redirectTo, children }: { redirectTo: string; children: ReactNode }) {
  const navigate = useNavigate();
  const { loading, session } = useAuth();

  useEffect(() => {
    if (!loading && !session) {
      void navigate({ to: "/auth", search: { redirect: redirectTo }, replace: true });
    }
  }, [loading, session, navigate, redirectTo]);

  if (loading) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[1240px] px-5 py-24 md:px-8">
          <MetaText>Verificando tu sesión…</MetaText>
        </div>
      </PublicLayout>
    );
  }

  if (!session) {
    return (
      <PublicLayout>
        <div className="mx-auto max-w-[620px] px-5 py-24 md:px-8">
          <Caption className="text-graphite">Compra segura</Caption>
          <DisplayHeading className="mt-4">Inicia sesión para continuar</DisplayHeading>
          <MetaText className="mt-4">
            Para comprar tickets necesitas una cuenta: así quedan asociados a tu perfil y puedes
            verlos cuando quieras.
          </MetaText>
          <div className="mt-8">
            <PillLink to="/auth" search={{ redirect: redirectTo }}>
              Ingresar o crear cuenta
            </PillLink>
          </div>
        </div>
      </PublicLayout>
    );
  }

  return <>{children}</>;
}
