import { randomUUID } from "node:crypto";
import { AppError, createEvent, type Logger } from "@shared/commons";
import type { Role } from "@shared/commons/auth";
import { enqueueOutbox, type Pool, type Queryable, withTransaction } from "@shared/commons/db";
import type { Config } from "../config.js";
import type { KeyStore } from "../crypto/keys.js";
import {
  assertPasswordPolicy,
  dummyPasswordHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../crypto/passwords.js";
import { normalizeEmail, type UserRecord, usersRepository } from "../users/repository.js";
import {
  type SessionContext,
  consumeOneTimeToken,
  consumeRefreshToken,
  invalidRefresh,
  issueOneTimeToken,
  issueRefreshToken,
  markRotated,
  revokeAllForUser,
  revokeFamily,
  signAccessToken,
} from "./tokens.js";

export const SERVICE_SOURCE = "identity";
const VERIFY_EMAIL_TTL_MINUTES = 24 * 60;
const RESET_PASSWORD_TTL_MINUTES = 60;

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
  emailVerified: boolean;
  status: "active" | "disabled";
  createdAt: string;
}

export interface SessionTokens {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
  user: PublicUser;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    roles: user.roles,
    emailVerified: user.emailVerifiedAt !== null,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

const invalidCredentials = () =>
  new AppError("UNAUTHENTICATED", undefined, {
    reason: "INVALID_CREDENTIALS",
    detail: "Email o contraseña incorrectos, o la cuenta está bloqueada temporalmente",
  });

export type IdentityConfig = Pick<
  Config,
  | "ACCESS_TOKEN_TTL_SECONDS"
  | "REFRESH_TOKEN_TTL_DAYS"
  | "PUBLIC_WEB_URL"
  | "LOGIN_MAX_FAILURES"
  | "LOGIN_LOCK_MINUTES"
>;

export function createAuthService(deps: {
  pool: Pool;
  keys: KeyStore;
  config: IdentityConfig;
  logger: Logger;
}) {
  const { pool, keys, config } = deps;

  async function startSession(
    db: Queryable,
    user: UserRecord,
    context: SessionContext,
    familyId?: string,
  ) {
    const refresh = await issueRefreshToken(
      db,
      user.id,
      config.REFRESH_TOKEN_TTL_DAYS,
      context,
      familyId,
    );
    return { refresh, user };
  }

  async function toTokens(
    started: Awaited<ReturnType<typeof startSession>>,
  ): Promise<SessionTokens> {
    const { refresh, user } = started;
    const accessToken = await signAccessToken(
      keys,
      {
        userId: user.id,
        roles: user.roles,
        emailVerified: user.emailVerifiedAt !== null,
        sessionId: refresh.familyId,
      },
      config.ACCESS_TOKEN_TTL_SECONDS,
    );
    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt.toISOString(),
      user: toPublicUser(user),
    };
  }

  async function enqueueVerification(
    db: Queryable,
    user: { id: string; email: string },
    correlationId?: string,
  ) {
    const token = await issueOneTimeToken(db, user.id, "verify_email", VERIFY_EMAIL_TTL_MINUTES);
    const verificationUrl = new URL(
      `/verificar-email?token=${token}`,
      config.PUBLIC_WEB_URL,
    ).toString();
    await enqueueOutbox(
      db,
      createEvent({
        type: "VerificacionEmailSolicitada",
        source: SERVICE_SOURCE,
        aggregateId: user.id,
        correlationId,
        data: { userId: user.id, email: user.email, verificationUrl },
      }),
    );
  }

  return {
    /**
     * Registro. No revela si el email ya existe (responde igual en ambos casos): evita enumerar
     * cuentas. Si es nuevo, encola `UsuarioRegistrado` y el correo de verificación.
     */
    async register(
      input: { email: string; password: string; fullName: string },
      correlationId?: string,
    ): Promise<void> {
      const email = normalizeEmail(input.email);
      assertPasswordPolicy(input.password, email);
      const passwordHash = await hashPassword(input.password);
      await withTransaction(pool, async (client) => {
        const id = randomUUID();
        const created = await usersRepository.insert(client, {
          id,
          email,
          passwordHash,
          fullName: input.fullName,
          emailVerified: false,
        });
        if (!created) {
          deps.logger.info("registro con email existente (respuesta genérica)");
          return;
        }
        await usersRepository.setRoles(client, id, ["customer"]);
        await enqueueOutbox(
          client,
          createEvent({
            type: "UsuarioRegistrado",
            source: SERVICE_SOURCE,
            aggregateId: id,
            correlationId,
            data: { userId: id, email },
          }),
        );
        await enqueueVerification(client, { id, email }, correlationId);
      });
    },

    async login(
      input: { email: string; password: string },
      context: SessionContext,
    ): Promise<SessionTokens> {
      const user = await usersRepository.findByEmail(pool, input.email);
      if (!user) {
        await verifyPassword(await dummyPasswordHash(), input.password);
        throw invalidCredentials();
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw invalidCredentials();

      const ok = await verifyPassword(user.passwordHash, input.password);
      if (!ok) {
        await usersRepository.registerFailedLogin(
          pool,
          user.id,
          config.LOGIN_MAX_FAILURES,
          config.LOGIN_LOCK_MINUTES,
        );
        throw invalidCredentials();
      }
      if (user.status !== "active") {
        throw new AppError("FORBIDDEN", undefined, {
          reason: "ACCOUNT_DISABLED",
          detail: "La cuenta está deshabilitada",
        });
      }
      const rehash = needsRehash(user.passwordHash)
        ? await hashPassword(input.password)
        : undefined;
      const started = await withTransaction(pool, async (client) => {
        await usersRepository.registerSuccessfulLogin(client, user.id, rehash);
        return startSession(client, user, context);
      });
      return toTokens(started);
    },

    /** Rotación: el refresh usado queda revocado y se emite uno nuevo de la misma familia. */
    async refresh(refreshToken: string, context: SessionContext): Promise<SessionTokens> {
      const outcome = await withTransaction(pool, async (client) => {
        const row = await consumeRefreshToken(client, refreshToken);
        if ("reuseDetected" in row) return row;
        const user = await usersRepository.findById(client, row.user_id);
        if (!user || user.status !== "active") {
          await revokeFamily(client, row.family_id, "user_disabled");
          return { inactive: true as const };
        }
        const started = await startSession(client, user, context, row.family_id);
        await markRotated(client, row.id, started.refresh.id);
        return started;
      });
      if ("reuseDetected" in outcome) {
        deps.logger.warn(
          { userId: outcome.userId },
          "reutilización de refresh token: sesión revocada",
        );
        throw invalidRefresh("REFRESH_TOKEN_REUSED");
      }
      if ("inactive" in outcome) throw invalidRefresh("ACCOUNT_DISABLED");
      return toTokens(outcome);
    },

    /** Cierra la sesión del refresh token (su familia). Idempotente y silencioso. */
    async logout(refreshToken: string): Promise<void> {
      await withTransaction(pool, async (client) => {
        try {
          const row = await consumeRefreshToken(client, refreshToken);
          if (!("reuseDetected" in row)) await revokeFamily(client, row.family_id, "logout");
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
        }
      });
    },

    async logoutAll(userId: string): Promise<void> {
      await revokeAllForUser(pool, userId, "logout_all");
    },

    async me(userId: string): Promise<PublicUser> {
      const user = await usersRepository.findById(pool, userId);
      if (!user || user.status !== "active")
        throw AppError.unauthenticated("La cuenta no está activa");
      return toPublicUser(user);
    },

    async updateProfile(userId: string, fullName: string): Promise<PublicUser> {
      await usersRepository.updateProfile(pool, userId, fullName);
      return this.me(userId);
    },

    async verifyEmail(token: string): Promise<void> {
      await withTransaction(pool, async (client) => {
        const userId = await consumeOneTimeToken(client, token, "verify_email");
        await usersRepository.markEmailVerified(client, userId);
      });
    },

    async resendVerification(userId: string, correlationId?: string): Promise<void> {
      await withTransaction(pool, async (client) => {
        const user = await usersRepository.findById(client, userId);
        if (!user || user.emailVerifiedAt) return;
        await enqueueVerification(client, user, correlationId);
      });
    },

    /** Siempre responde igual exista o no la cuenta. */
    async forgotPassword(email: string, correlationId?: string): Promise<void> {
      await withTransaction(pool, async (client) => {
        const user = await usersRepository.findByEmail(client, email);
        if (!user || user.status !== "active") return;
        const token = await issueOneTimeToken(
          client,
          user.id,
          "reset_password",
          RESET_PASSWORD_TTL_MINUTES,
        );
        const resetUrl = new URL(
          `/restablecer-contrasena?token=${token}`,
          config.PUBLIC_WEB_URL,
        ).toString();
        await enqueueOutbox(
          client,
          createEvent({
            type: "RecuperacionContrasenaSolicitada",
            source: SERVICE_SOURCE,
            aggregateId: user.id,
            correlationId,
            data: { userId: user.id, email: user.email, resetUrl },
          }),
        );
      });
    },

    /** Restablece la contraseña y cierra todas las sesiones (quien la robó pierde el acceso). */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      await withTransaction(pool, async (client) => {
        const userId = await consumeOneTimeToken(client, token, "reset_password");
        const user = await usersRepository.findById(client, userId, true);
        if (!user) throw AppError.notFound();
        assertPasswordPolicy(newPassword, user.email);
        await usersRepository.updatePassword(client, userId, await hashPassword(newPassword));
        // Abrir el enlace del correo también prueba que el email es suyo.
        await usersRepository.markEmailVerified(client, userId);
        await revokeAllForUser(client, userId, "password_reset");
      });
    },

    /** Cambia la contraseña y revoca las demás sesiones (mantiene la actual). */
    async changePassword(
      userId: string,
      sessionId: string | undefined,
      currentPassword: string,
      newPassword: string,
    ): Promise<void> {
      const user = await usersRepository.findById(pool, userId);
      if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
        throw new AppError("VALIDATION", undefined, {
          reason: "INVALID_CURRENT_PASSWORD",
          issues: [{ path: "currentPassword", message: "La contraseña actual no es correcta" }],
        });
      }
      assertPasswordPolicy(newPassword, user.email);
      const passwordHash = await hashPassword(newPassword);
      await withTransaction(pool, async (client) => {
        await usersRepository.updatePassword(client, userId, passwordHash);
        await client.query(
          `update refresh_tokens set revoked_at = now(), revoked_reason = 'password_changed'
            where user_id = $1 and revoked_at is null and family_id is distinct from $2`,
          [userId, sessionId ?? null],
        );
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
