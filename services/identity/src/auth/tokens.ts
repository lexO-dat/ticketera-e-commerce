import { randomUUID } from "node:crypto";
import { AppError, randomToken, safeEqual, sha256Hex } from "@shared/commons";
import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  type Role,
} from "@shared/commons/auth";
import type { Queryable } from "@shared/commons/db";
import { SignJWT } from "jose";
import type { KeyStore } from "../crypto/keys.js";

export interface AccessTokenSubject {
  userId: string;
  roles: Role[];
  emailVerified: boolean;
  sessionId: string;
}

/** Token de acceso corto (≤ 15 min), firmado con la clave EdDSA activa. */
export async function signAccessToken(
  keys: KeyStore,
  subject: AccessTokenSubject,
  ttlSeconds: number,
): Promise<string> {
  const key = await keys.current();
  return new SignJWT({
    roles: subject.roles,
    email_verified: subject.emailVerified,
    sid: subject.sessionId,
  })
    .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid: key.kid, typ: "at+jwt" })
    .setIssuer(ACCESS_TOKEN_ISSUER)
    .setAudience(ACCESS_TOKEN_AUDIENCE)
    .setSubject(subject.userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key.privateKey);
}

/** Refresh token opaco: `<id>.<secreto>`. En la BD solo queda el SHA-256 del secreto. */
export interface IssuedRefreshToken {
  token: string;
  id: string;
  familyId: string;
  expiresAt: Date;
}

export interface SessionContext {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

const REFRESH_TOKEN_PATTERN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
/** Si dos solicitudes rotan el mismo token casi a la vez (pestañas), no se trata como robo. */
export const ROTATION_GRACE_SECONDS = 30;

export async function issueRefreshToken(
  db: Queryable,
  userId: string,
  ttlDays: number,
  context: SessionContext,
  familyId: string = randomUUID(),
): Promise<IssuedRefreshToken> {
  const id = randomUUID();
  const secret = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.query(
    `insert into refresh_tokens (id, family_id, user_id, token_hash, expires_at, user_agent, ip)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      familyId,
      userId,
      sha256Hex(secret),
      expiresAt,
      context.userAgent?.slice(0, 300) ?? null,
      context.ip ?? null,
    ],
  );
  return { token: `${id}.${secret}`, id, familyId, expiresAt };
}

interface RefreshRow {
  id: string;
  family_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

export const invalidRefresh = (reason = "REFRESH_TOKEN_INVALID") =>
  new AppError("UNAUTHENTICATED", undefined, {
    reason,
    detail: "La sesión no es válida; inicia sesión de nuevo",
  });

/**
 * Valida y bloquea (`FOR UPDATE`) el refresh token. Detecta reutilización: si llega un token ya
 * rotado fuera del margen de gracia, alguien lo copió → se revoca la familia (la sesión) completa.
 * Debe llamarse dentro de una transacción. En caso de reutilización devuelve `{ reuseDetected }`
 * en vez de lanzar, para que la transacción haga COMMIT de la revocación antes de responder 401.
 */
export async function consumeRefreshToken(
  db: Queryable,
  token: string,
): Promise<RefreshRow | { reuseDetected: true; userId: string }> {
  const match = REFRESH_TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2]) throw invalidRefresh();
  const { rows } = await db.query<RefreshRow>(
    `select id, family_id, user_id, token_hash, expires_at, revoked_at, replaced_by
       from refresh_tokens where id = $1 for update`,
    [match[1]],
  );
  const row = rows[0];
  if (!row || !safeEqual(row.token_hash, sha256Hex(match[2]))) throw invalidRefresh();

  if (row.revoked_at) {
    const rotatedRecently =
      row.replaced_by !== null &&
      Date.now() - row.revoked_at.getTime() < ROTATION_GRACE_SECONDS * 1000;
    if (rotatedRecently) throw invalidRefresh("REFRESH_TOKEN_ROTATED");
    await revokeFamily(db, row.family_id, "reuse_detected");
    return { reuseDetected: true, userId: row.user_id };
  }
  if (row.expires_at.getTime() <= Date.now()) throw invalidRefresh("REFRESH_TOKEN_EXPIRED");
  return row;
}

export async function markRotated(db: Queryable, id: string, replacedBy: string): Promise<void> {
  await db.query(
    "update refresh_tokens set revoked_at = now(), revoked_reason = 'rotated', replaced_by = $2 where id = $1",
    [id, replacedBy],
  );
}

export async function revokeFamily(db: Queryable, familyId: string, reason: string): Promise<void> {
  await db.query(
    "update refresh_tokens set revoked_at = now(), revoked_reason = $2 where family_id = $1 and revoked_at is null",
    [familyId, reason],
  );
}

export async function revokeAllForUser(
  db: Queryable,
  userId: string,
  reason: string,
): Promise<void> {
  await db.query(
    "update refresh_tokens set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null",
    [userId, reason],
  );
}

/** Tokens de un solo uso (enlaces por correo). Devuelve el token en claro para el enlace. */
export async function issueOneTimeToken(
  db: Queryable,
  userId: string,
  purpose: "verify_email" | "reset_password",
  ttlMinutes: number,
): Promise<string> {
  // Un enlace nuevo invalida los anteriores del mismo tipo.
  await db.query(
    "update one_time_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null",
    [userId, purpose],
  );
  const token = randomToken(32);
  await db.query(
    `insert into one_time_tokens (id, user_id, purpose, token_hash, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
    [randomUUID(), userId, purpose, sha256Hex(token), ttlMinutes],
  );
  return token;
}

/** Consume el token de forma atómica (un solo uso aunque lleguen dos solicitudes a la vez). */
export async function consumeOneTimeToken(
  db: Queryable,
  token: string,
  purpose: "verify_email" | "reset_password",
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw invalidLink();
  const { rows } = await db.query<{ user_id: string }>(
    `update one_time_tokens set used_at = now()
      where token_hash = $1 and purpose = $2 and used_at is null and expires_at > now()
      returning user_id`,
    [sha256Hex(token), purpose],
  );
  if (!rows[0]) throw invalidLink();
  return rows[0].user_id;
}

function invalidLink(): AppError {
  return new AppError("VALIDATION", undefined, {
    reason: "TOKEN_INVALID_OR_EXPIRED",
    detail: "El enlace no es válido o expiró",
  });
}
