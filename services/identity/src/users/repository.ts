import type { Role } from "@shared/commons/auth";
import type { Queryable } from "@shared/commons/db";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  status: "active" | "disabled";
  emailVerifiedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
  roles: Role[];
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  status: "active" | "disabled";
  email_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
  roles: Role[] | null;
}

const SELECT_USER = `
  select u.id, u.email, u.password_hash, u.full_name, u.status, u.email_verified_at,
         u.failed_login_count, u.locked_until, u.created_at,
         coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}') as roles
    from users u
    left join user_roles r on r.user_id = u.id`;

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    fullName: row.full_name,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    roles: row.roles ?? [],
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const usersRepository = {
  async findByEmail(
    db: Queryable,
    email: string,
    forUpdate = false,
  ): Promise<UserRecord | undefined> {
    const sql = forUpdate
      ? `${SELECT_USER} where u.id = (select id from users where email = $1 for update) group by u.id`
      : `${SELECT_USER} where u.email = $1 group by u.id`;
    const { rows } = await db.query<UserRow>(sql, [normalizeEmail(email)]);
    return rows[0] ? toUser(rows[0]) : undefined;
  },

  async findById(db: Queryable, id: string, forUpdate = false): Promise<UserRecord | undefined> {
    const sql = forUpdate
      ? `${SELECT_USER} where u.id = (select id from users where id = $1 for update) group by u.id`
      : `${SELECT_USER} where u.id = $1 group by u.id`;
    const { rows } = await db.query<UserRow>(sql, [id]);
    return rows[0] ? toUser(rows[0]) : undefined;
  },

  /** Inserta si el email no existe. Devuelve `false` si ya existía (sin error, para no filtrarlo). */
  async insert(
    db: Queryable,
    user: {
      id: string;
      email: string;
      passwordHash: string;
      fullName: string;
      emailVerified: boolean;
    },
  ): Promise<boolean> {
    const result = await db.query(
      `insert into users (id, email, password_hash, full_name, email_verified_at)
       values ($1, $2, $3, $4, case when $5 then now() end)
       on conflict (email) do nothing`,
      [user.id, normalizeEmail(user.email), user.passwordHash, user.fullName, user.emailVerified],
    );
    return result.rowCount === 1;
  },

  async setRoles(db: Queryable, userId: string, roles: Role[]): Promise<void> {
    await db.query("delete from user_roles where user_id = $1 and role <> all($2::text[])", [
      userId,
      roles,
    ]);
    await db.query(
      `insert into user_roles (user_id, role) select $1, unnest($2::text[]) on conflict do nothing`,
      [userId, roles],
    );
  },

  async registerFailedLogin(
    db: Queryable,
    userId: string,
    maxFailures: number,
    lockMinutes: number,
  ) {
    // Atómico: el contador se incrementa en la BD (nunca leer-modificar-escribir en la app).
    await db.query(
      `update users
          set failed_login_count = case when failed_login_count + 1 >= $2 then 0 else failed_login_count + 1 end,
              locked_until = case when failed_login_count + 1 >= $2
                                  then now() + make_interval(mins => $3) else locked_until end,
              updated_at = now()
        where id = $1`,
      [userId, maxFailures, lockMinutes],
    );
  },

  async registerSuccessfulLogin(db: Queryable, userId: string, newPasswordHash?: string) {
    await db.query(
      `update users set failed_login_count = 0, locked_until = null,
              password_hash = coalesce($2, password_hash), updated_at = now()
        where id = $1`,
      [userId, newPasswordHash ?? null],
    );
  },

  async updatePassword(db: Queryable, userId: string, passwordHash: string) {
    await db.query(
      "update users set password_hash = $2, failed_login_count = 0, locked_until = null, updated_at = now() where id = $1",
      [userId, passwordHash],
    );
  },

  async markEmailVerified(db: Queryable, userId: string) {
    await db.query(
      "update users set email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1",
      [userId],
    );
  },

  async updateProfile(db: Queryable, userId: string, fullName: string) {
    await db.query("update users set full_name = $2, updated_at = now() where id = $1", [
      userId,
      fullName,
    ]);
  },

  async setStatus(db: Queryable, userId: string, status: "active" | "disabled") {
    await db.query("update users set status = $2, updated_at = now() where id = $1", [
      userId,
      status,
    ]);
  },

  async countByRole(db: Queryable, role: Role): Promise<number> {
    const { rows } = await db.query<{ count: bigint }>(
      `select count(*) as count from user_roles r join users u on u.id = r.user_id
        where r.role = $1 and u.status = 'active'`,
      [role],
    );
    return Number(rows[0]?.count ?? 0n);
  },

  /** Paginación por cursor (created_at, id): estable aunque se inserten usuarios nuevos. */
  async list(
    db: Queryable,
    options: {
      query?: string | undefined;
      role?: Role | undefined;
      limit: number;
      cursor?: { createdAt: Date; id: string } | undefined;
    },
  ): Promise<UserRecord[]> {
    const params: unknown[] = [];
    const where: string[] = [];
    if (options.query) {
      params.push(`%${options.query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
      where.push(`(u.email ilike $${params.length} or u.full_name ilike $${params.length})`);
    }
    if (options.role) {
      params.push(options.role);
      where.push(
        `exists (select 1 from user_roles x where x.user_id = u.id and x.role = $${params.length})`,
      );
    }
    if (options.cursor) {
      params.push(options.cursor.createdAt, options.cursor.id);
      where.push(`(u.created_at, u.id) < ($${params.length - 1}, $${params.length})`);
    }
    params.push(options.limit);
    const { rows } = await db.query<UserRow>(
      `${SELECT_USER} ${where.length ? `where ${where.join(" and ")}` : ""}
        group by u.id order by u.created_at desc, u.id desc limit $${params.length}`,
      params,
    );
    return rows.map(toUser);
  },
};
