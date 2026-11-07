import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { GatewayError, gatewayFetch, gatewayUrl } from "./gateway.server";

/** Cookies HttpOnly: el JavaScript del navegador nunca puede leer los tokens (mitiga XSS). */
const ACCESS_COOKIE = "tk_at";
const REFRESH_COOKIE = "tk_rt";

export type Role = "customer" | "organizer" | "seller" | "staff" | "admin";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
  emailVerified: boolean;
}

export interface SessionTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  user: SessionUser;
}

export interface AuthContext {
  userId: string;
  roles: Role[];
  emailVerified: boolean;
  accessToken: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
function keySet() {
  jwks ??= createRemoteJWKSet(new URL("/.well-known/jwks.json", gatewayUrl()), {
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
  });
  return jwks;
}

function secureCookies(): boolean {
  return process.env["COOKIE_SECURE"] !== "false";
}

export function storeSession(tokens: SessionTokens): void {
  const secure = secureCookies();
  setCookie(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: tokens.expiresIn,
  });
  setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    // Strict: el refresh token nunca viaja en navegaciones iniciadas por otro sitio.
    sameSite: "strict",
    path: "/",
    expires: new Date(tokens.refreshExpiresAt),
  });
}

export function clearSession(): void {
  deleteCookie(ACCESS_COOKIE, { path: "/" });
  deleteCookie(REFRESH_COOKIE, { path: "/" });
}

export function refreshTokenCookie(): string | undefined {
  return getCookie(REFRESH_COOKIE);
}

async function verify(accessToken: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(accessToken, keySet(), {
    issuer: "ticketera-identity",
    audience: "ticketera",
    algorithms: ["EdDSA"],
    clockTolerance: 5,
  });
  return {
    userId: String(payload.sub),
    roles: (Array.isArray(payload["roles"]) ? payload["roles"] : []) as Role[],
    emailVerified: payload["email_verified"] === true,
    accessToken,
  };
}

/**
 * Sesión de la solicitud actual: valida el token de acceso de la cookie y, si venció, lo renueva
 * con el refresh token (rotación en identity). `null` si no hay sesión válida.
 */
export async function currentAuth(): Promise<AuthContext | null> {
  const accessToken = getCookie(ACCESS_COOKIE);
  if (accessToken) {
    try {
      return await verify(accessToken);
    } catch {
      // Vencido o inválido: se intenta renovar.
    }
  }
  const refreshToken = getCookie(REFRESH_COOKIE);
  if (!refreshToken) return null;
  try {
    const tokens = await gatewayFetch<SessionTokens>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
    });
    storeSession(tokens);
    return await verify(tokens.accessToken);
  } catch (error) {
    // Otra solicitud paralela ya rotó el token: sus cookies nuevas llegan en su respuesta.
    if (error instanceof GatewayError && error.reason === "REFRESH_TOKEN_ROTATED") return null;
    if (error instanceof GatewayError && error.status === 401) clearSession();
    return null;
  }
}
