import { createFileRoute, Link, Outlet, redirect, useNavigate } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";
import { Wordmark } from "@/components/kit/Wordmark";
import { GhostButton } from "@/components/kit/PillButton";
import { Caption } from "@/components/kit/Text";

const NAV: {
  to:
    | "/admin"
    | "/admin/eventos"
    | "/admin/recintos"
    | "/admin/ordenes"
    | "/admin/promociones"
    | "/admin/equipo";
  label: string;
  exact?: boolean;
}[] = [
  { to: "/admin", label: "Dashboard", exact: true },
  { to: "/admin/eventos", label: "Eventos" },
  { to: "/admin/recintos", label: "Recintos y mapas" },
  { to: "/admin/ordenes", label: "Órdenes" },
  { to: "/admin/promociones", label: "Promociones" },
  { to: "/admin/equipo", label: "Equipo" },
];

export const Route = createFileRoute("/admin")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  head: () => ({
    meta: [
      { title: "Panel de administración — Ticketera" },
      { name: "description", content: "Gestión de eventos, mapas, filas virtuales y ventas." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLayout,
  errorComponent: ({ error }) => (
    <div className="p-10" role="alert">
      <p className="text-body text-ember">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  ),
  notFoundComponent: () => <div className="p-10">Sección no encontrada.</div>,
});

function AdminLayout() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-20 border-b border-ash bg-paper/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-6 px-5 py-4 md:px-8">
          <Link to="/" className="flex items-center gap-3">
            <Wordmark />
            <Caption className="text-graphite">Admin</Caption>
          </Link>

          <nav className="flex flex-wrap items-center gap-5">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact ?? false }}
                activeProps={{ className: "text-carbon underline underline-offset-4" }}
                inactiveProps={{ className: "text-graphite" }}
                className="text-body transition-opacity hover:opacity-60"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto">
            <GhostButton
              arrow={false}
              onClick={() => {
                void supabase.auth.signOut().then(() => navigate({ to: "/auth" }));
              }}
            >
              <span className="text-graphite underline">Cerrar sesión</span>
            </GhostButton>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-5 py-10 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
