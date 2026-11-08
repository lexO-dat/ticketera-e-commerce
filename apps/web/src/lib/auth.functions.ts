import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Autenticación de la web contra identity (vía gateway). Reemplaza a `supabase.auth.*`.
 * Los tokens quedan en cookies HttpOnly; al cliente solo llegan los datos públicos del usuario.
 */

export type PublicSessionUser = {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  emailVerified: boolean;
  isAdmin: boolean;
};

type GatewayUser = {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  emailVerified: boolean;
};

function toPublic(user: GatewayUser): PublicSessionUser {
  return { ...user, isAdmin: user.roles.includes("admin") };
}

/** Mensaje seguro para la UI a partir de un error del gateway. */
async function friendly(error: unknown): Promise<never> {
  const { GatewayError } = await import("./auth/gateway.server");
  if (error instanceof GatewayError) {
    if (error.status === 429)
      throw new Error("Demasiados intentos. Espera un momento y vuelve a intentar.");
    throw new Error(error.message);
  }
  throw error;
}

export const currentUser = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicSessionUser | null> => {
    const { currentAuth } = await import("./auth/session.server");
    const { gatewayFetch, GatewayError } = await import("./auth/gateway.server");
    const auth = await currentAuth();
    if (!auth) return null;
    try {
      const user = await gatewayFetch<GatewayUser>("/auth/me", { accessToken: auth.accessToken });
      return toPublic(user);
    } catch (error) {
      if (error instanceof GatewayError && error.status === 401) return null;
      throw error;
    }
  },
);

export const signIn = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) })
      .parse(input),
  )
  .handler(async ({ data }): Promise<PublicSessionUser> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    const { storeSession } = await import("./auth/session.server");
    try {
      const tokens = await gatewayFetch<Parameters<typeof storeSession>[0]>("/auth/login", {
        method: "POST",
        body: data,
      });
      storeSession(tokens);
      return toPublic(tokens.user);
    } catch (error) {
      return friendly(error);
    }
  });

export const signUp = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({
        email: z.string().trim().email().max(254),
        password: z.string().min(1).max(128),
        fullName: z.string().trim().min(1).max(120),
      })
      .parse(input),
  )
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    try {
      await gatewayFetch("/auth/register", { method: "POST", body: data });
      return { ok: true };
    } catch (error) {
      return friendly(error);
    }
  });

export const signOut = createServerFn({ method: "POST" }).handler(async () => {
  const { gatewayFetch } = await import("./auth/gateway.server");
  const { clearSession, refreshTokenCookie } = await import("./auth/session.server");
  const refreshToken = refreshTokenCookie();
  clearSession();
  if (refreshToken) {
    await gatewayFetch("/auth/logout", { method: "POST", body: { refreshToken } }).catch(
      () => undefined,
    );
  }
  return { ok: true };
});

export const verifyEmail = createServerFn({ method: "POST" })
  .validator((input: unknown) => z.object({ token: z.string().min(1).max(200) }).parse(input))
  .handler(async ({ data }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    try {
      await gatewayFetch("/auth/email/verify", { method: "POST", body: data });
      return { ok: true };
    } catch (error) {
      return friendly(error);
    }
  });

export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z.object({ email: z.string().trim().email().max(254) }).parse(input),
  )
  .handler(async ({ data }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    try {
      await gatewayFetch("/auth/password/forgot", { method: "POST", body: data });
      return { ok: true };
    } catch (error) {
      return friendly(error);
    }
  });

export const resetPassword = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    z
      .object({ token: z.string().min(1).max(200), newPassword: z.string().min(1).max(128) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { gatewayFetch } = await import("./auth/gateway.server");
    try {
      await gatewayFetch("/auth/password/reset", { method: "POST", body: data });
      return { ok: true };
    } catch (error) {
      return friendly(error);
    }
  });
