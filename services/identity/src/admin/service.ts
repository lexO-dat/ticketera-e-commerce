import { randomUUID } from "node:crypto";
import { AppError, createEvent } from "@shared/commons";
import type { Role } from "@shared/commons/auth";
import { enqueueOutbox, type Pool, type Queryable, withTransaction } from "@shared/commons/db";
import { assertPasswordPolicy, hashPassword } from "../crypto/passwords.js";
import { revokeAllForUser } from "../auth/tokens.js";
import { type PublicUser, SERVICE_SOURCE, toPublicUser } from "../auth/service.js";
import { normalizeEmail, usersRepository } from "../users/repository.js";

// Serializa los cambios que podrían dejar la plataforma sin administradores.
const ADMIN_CHANGES_LOCK = 7_340_112_102n;

export interface UserPage {
  items: PublicUser[];
  nextCursor: string | null;
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const date = new Date(createdAt ?? "");
  if (!id || Number.isNaN(date.getTime()) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw AppError.validation([{ path: "cursor", message: "Cursor inválido" }]);
  }
  return { createdAt: date, id };
}

async function assertAdminRemains(db: Queryable, userId: string): Promise<void> {
  const { rows } = await db.query<{ count: bigint }>(
    `select count(*) as count from user_roles r join users u on u.id = r.user_id
      where r.role = 'admin' and u.status = 'active' and u.id <> $1`,
    [userId],
  );
  if ((rows[0]?.count ?? 0n) === 0n) {
    throw AppError.conflict("LAST_ADMIN", "Debe quedar al menos un administrador activo");
  }
}

export function createAdminService(pool: Pool) {
  async function getUser(db: Queryable, userId: string) {
    const user = await usersRepository.findById(db, userId, true);
    if (!user) throw AppError.notFound("El usuario no existe");
    return user;
  }

  return {
    async list(options: {
      query?: string | undefined;
      role?: Role | undefined;
      limit: number;
      cursor?: string | undefined;
    }): Promise<UserPage> {
      const users = await usersRepository.list(pool, {
        query: options.query,
        role: options.role,
        limit: options.limit + 1,
        cursor: options.cursor ? decodeCursor(options.cursor) : undefined,
      });
      const page = users.slice(0, options.limit).map(toPublicUser);
      const last = page.at(-1);
      return {
        items: page,
        nextCursor:
          users.length > options.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async get(userId: string): Promise<PublicUser> {
      return toPublicUser(await getUser(pool, userId));
    },

    /** Alta de cuentas de equipo (staff, organizadores, vendedores) con email ya verificado. */
    async create(
      input: { email: string; fullName: string; password: string; roles: Role[] },
      correlationId?: string,
    ): Promise<PublicUser> {
      const email = normalizeEmail(input.email);
      assertPasswordPolicy(input.password, email);
      const passwordHash = await hashPassword(input.password);
      return withTransaction(pool, async (client) => {
        const id = randomUUID();
        const created = await usersRepository.insert(client, {
          id,
          email,
          passwordHash,
          fullName: input.fullName,
          emailVerified: true,
        });
        if (!created) throw AppError.conflict("EMAIL_TAKEN", "Ya existe una cuenta con ese email");
        await usersRepository.setRoles(client, id, input.roles);
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
        return toPublicUser(await getUser(client, id));
      });
    },

    async setRoles(actorId: string, userId: string, roles: Role[]): Promise<PublicUser> {
      return withTransaction(pool, async (client) => {
        await client.query("select pg_advisory_xact_lock($1)", [ADMIN_CHANGES_LOCK]);
        const user = await getUser(client, userId);
        if (user.roles.includes("admin") && !roles.includes("admin")) {
          if (actorId === userId)
            throw AppError.forbidden("No puedes quitarte el rol de administrador");
          await assertAdminRemains(client, userId);
        }
        await usersRepository.setRoles(client, userId, roles);
        // Los permisos nuevos rigen al refrescar: se fuerzan sesiones nuevas.
        await revokeAllForUser(client, userId, "roles_changed");
        return toPublicUser(await getUser(client, userId));
      });
    },

    async setStatus(
      actorId: string,
      userId: string,
      status: "active" | "disabled",
    ): Promise<PublicUser> {
      if (actorId === userId)
        throw AppError.forbidden("No puedes cambiar el estado de tu propia cuenta");
      return withTransaction(pool, async (client) => {
        await client.query("select pg_advisory_xact_lock($1)", [ADMIN_CHANGES_LOCK]);
        const user = await getUser(client, userId);
        if (status === "disabled" && user.roles.includes("admin"))
          await assertAdminRemains(client, userId);
        await usersRepository.setStatus(client, userId, status);
        if (status === "disabled") await revokeAllForUser(client, userId, "account_disabled");
        return toPublicUser(await getUser(client, userId));
      });
    },
  };
}

export type AdminService = ReturnType<typeof createAdminService>;

/** Crea el primer administrador si no hay ninguno (BOOTSTRAP_ADMIN_*). */
export async function bootstrapAdmin(
  pool: Pool,
  email: string,
  password: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [ADMIN_CHANGES_LOCK]);
    if ((await usersRepository.countByRole(client, "admin")) > 0) return false;
    const existing = await usersRepository.findByEmail(client, email);
    if (existing) {
      await usersRepository.setRoles(client, existing.id, [
        ...new Set<Role>([...existing.roles, "admin"]),
      ]);
      return true;
    }
    const id = randomUUID();
    await usersRepository.insert(client, {
      id,
      email,
      passwordHash: await hashPassword(password),
      fullName: "Administrador",
      emailVerified: true,
    });
    await usersRepository.setRoles(client, id, ["admin"]);
    return true;
  });
}
