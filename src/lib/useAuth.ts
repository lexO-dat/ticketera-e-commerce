import { useEffect, useState } from "react";

import { currentUser, type PublicSessionUser } from "@/lib/auth.functions";

export type AuthSession = { user: PublicSessionUser };

export type AuthState = {
  loading: boolean;
  session: AuthSession | null;
  isAdmin: boolean;
};

// Estado compartido entre componentes: una sola consulta y notificación tras login/logout.
let cached: AuthState | undefined;
let inflight: Promise<AuthState> | undefined;
const listeners = new Set<(state: AuthState) => void>();

function load(): Promise<AuthState> {
  inflight ??= currentUser()
    .then((user) => ({
      loading: false,
      session: user ? { user } : null,
      isAdmin: Boolean(user?.isAdmin),
    }))
    .catch(() => ({ loading: false, session: null, isAdmin: false }))
    .then((state) => {
      cached = state;
      inflight = undefined;
      for (const listener of listeners) listener(state);
      return state;
    });
  return inflight;
}

/** Vuelve a consultar la sesión (llamar después de iniciar o cerrar sesión). */
export function refreshAuth(): Promise<AuthState> {
  cached = undefined;
  return load();
}

/** Sesión reactiva del cliente (identity vía BFF) + flag de rol admin. */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>(
    cached ?? { loading: true, session: null, isAdmin: false },
  );

  useEffect(() => {
    listeners.add(setState);
    if (!cached) void load();
    return () => {
      listeners.delete(setState);
    };
  }, []);

  return state;
}
