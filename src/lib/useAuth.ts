import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

export type AuthState = {
  loading: boolean;
  session: Session | null;
  isAdmin: boolean;
};

/** Sesión reactiva del cliente + flag de rol admin (leído de user_roles). */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    session: null,
    isAdmin: false,
  });

  useEffect(() => {
    let alive = true;

    async function resolveRole(session: Session | null) {
      if (!session) return false;
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", session.user.id)
        .eq("role", "admin")
        .maybeSingle();
      return Boolean(data);
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setState({ loading: false, session, isAdmin: false });
      void resolveRole(session).then((isAdmin) => {
        if (alive) setState({ loading: false, session, isAdmin });
      });
    });

    void supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      const isAdmin = await resolveRole(data.session);
      if (alive) setState({ loading: false, session: data.session, isAdmin });
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
