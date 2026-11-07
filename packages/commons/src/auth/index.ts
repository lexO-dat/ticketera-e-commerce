import type { FastifyReply, FastifyRequest } from "fastify";
import {
  type JWTPayload,
  type JWTVerifyGetKey,
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import { AppError } from "../errors.js";

/** Roles de la plataforma (ADR-04). Reemplazan a `has_role` + RLS de Supabase. */
export const Roles = ["customer", "organizer", "seller", "staff", "admin"] as const;
export type Role = (typeof Roles)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (Roles as readonly string[]).includes(value);
}

/** Emisor y audiencia de los tokens de acceso de `identity`. */
export const ACCESS_TOKEN_ISSUER = "ticketera-identity";
export const ACCESS_TOKEN_AUDIENCE = "ticketera";
/** EdDSA (Ed25519) es el único algoritmo aceptado: nunca `none` ni HS* con clave pública. */
export const ACCESS_TOKEN_ALGORITHM = "EdDSA";

/** Usuario autenticado tal como lo ve cualquier servicio tras verificar el token. */
export interface AuthUser {
  id: string;
  roles: Role[];
  emailVerified: boolean;
  /** Familia de refresh token (sesión) que emitió el token. */
  sessionId: string | undefined;
  tokenId: string | undefined;
}

export interface AccessTokenClaims extends JWTPayload {
  sub: string;
  roles: Role[];
  email_verified: boolean;
  sid?: string;
}

export interface TokenVerifierOptions {
  /** URL del JWKS (`<identity>/.well-known/jwks.json`). */
  jwksUrl?: string | URL;
  /** Alternativa a `jwksUrl` (pruebas o el propio `identity`). */
  getKey?: JWTVerifyGetKey;
  issuer?: string;
  audience?: string;
  /** Tolerancia de reloj entre máquinas. */
  clockToleranceSeconds?: number;
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

/**
 * Verifica tokens de acceso contra el JWKS de `identity` (con caché y rotación de claves) y
 * devuelve el usuario. Cualquier fallo es `UNAUTHENTICATED`, sin detallar la causa al cliente.
 */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const getKey =
    options.getKey ??
    (options.jwksUrl
      ? createRemoteJWKSet(new URL(options.jwksUrl), {
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
          timeoutDuration: 3_000,
        })
      : undefined);
  if (!getKey) throw new Error("createTokenVerifier requiere jwksUrl o getKey");

  return async (token) => {
    try {
      const { payload } = await jwtVerify<AccessTokenClaims>(token, getKey, {
        issuer: options.issuer ?? ACCESS_TOKEN_ISSUER,
        audience: options.audience ?? ACCESS_TOKEN_AUDIENCE,
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        clockTolerance: options.clockToleranceSeconds ?? 5,
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (!Array.isArray(payload.roles) || !payload.roles.every(isRole)) {
        throw AppError.unauthenticated("Token inválido");
      }
      return {
        id: payload.sub,
        roles: payload.roles,
        emailVerified: payload.email_verified === true,
        sessionId: payload.sid,
        tokenId: payload.jti,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
        throw AppError.unavailable("No se pudo verificar la sesión");
      }
      const detail = error instanceof joseErrors.JWTExpired ? "La sesión expiró" : "Token inválido";
      throw new AppError("UNAUTHENTICATED", undefined, { detail, cause: error });
    }
  };
}

/** JWKS local (claves en memoria), útil en pruebas. */
export function localKeySet(jwks: { keys: Record<string, unknown>[] }): JWTVerifyGetKey {
  return createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
}

/** Extrae el token de `Authorization: Bearer <token>`; `undefined` si no viene. */
export function bearerToken(request: Pick<FastifyRequest, "headers">): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  if (!match?.[1]) throw AppError.unauthenticated("Cabecera Authorization inválida");
  return match[1];
}

declare module "fastify" {
  interface FastifyRequest {
    /** Usuario autenticado (lo fija `authenticate`). */
    user?: AuthUser;
  }
}

export interface AuthGuards {
  /** preHandler: exige token válido; con `roles`, además uno de esos roles. */
  required(...roles: Role[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** preHandler: si viene token lo valida (y falla si es inválido); si no, sigue anónimo. */
  optional(): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

/**
 * Guardas para rutas Fastify. Reemplazan a RLS: la autorización por rol se hace aquí y la de
 * propiedad del recurso (`resource.userId === request.user.id`) en el servicio.
 */
export function authGuards(verify: TokenVerifier): AuthGuards {
  return {
    required:
      (...roles) =>
      async (request) => {
        const token = bearerToken(request);
        if (!token) throw AppError.unauthenticated("Inicia sesión para continuar");
        const user = await verify(token);
        if (roles.length > 0 && !roles.some((role) => user.roles.includes(role))) {
          throw AppError.forbidden("No tienes permisos para esta acción");
        }
        request.user = user;
      },
    optional: () => async (request) => {
      const token = bearerToken(request);
      if (token) request.user = await verify(token);
    },
  };
}

/** Lanza FORBIDDEN si el usuario no es dueño del recurso ni tiene un rol privilegiado. */
export function assertOwnerOrRole(user: AuthUser, ownerId: string, ...roles: Role[]): void {
  if (user.id === ownerId) return;
  if (roles.some((role) => user.roles.includes(role))) return;
  throw AppError.forbidden("No tienes acceso a este recurso");
}
