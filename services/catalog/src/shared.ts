import { AppError, type CLP, clpToJson, nonNegativeClp, secureCode } from "@shared/commons";
import type { AuthUser } from "@shared/commons/auth";
import { z } from "zod";

/** Usuario autenticado que ejecuta una acción de administración. */
export type Actor = Pick<AuthUser, "id" | "roles">;

export function isAdmin(actor: Actor): boolean {
  return actor.roles.includes("admin");
}

/**
 * Reemplaza a RLS: `admin` administra todo; el resto (organizer / seller) solo lo suyo.
 * Un recurso sin dueño (`null`) es de la plataforma: solo `admin`.
 */
export function assertCanManage(actor: Actor, ownerId: string | null): void {
  if (isAdmin(actor)) return;
  if (ownerId !== null && ownerId === actor.id) return;
  // 404 en vez de 403: no se revela que el recurso existe.
  throw AppError.notFound();
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
}

/** Slug único y no adivinable a partir de un título (sufijo aleatorio criptográfico). */
export function uniqueSlug(title: string): string {
  const base = slugify(title) || "item";
  return `${base}-${secureCode(5).toLowerCase()}`;
}

/** Monto CLP en JSON: string decimal (los `bigint` no son serializables). */
export function money(value: bigint | string | number): string {
  return clpToJson(nonNegativeClp(value));
}

/** Entrada de un monto CLP: entero no negativo (número o string decimal), máx. 1.000 millones. */
export const clpInput = z
  .union([z.int().min(0), z.string().regex(/^\d{1,13}$/)])
  .transform((value, ctx): CLP => {
    const amount = nonNegativeClp(value);
    if (amount > 1_000_000_000n) {
      ctx.addIssue({ code: "custom", message: "Monto fuera de rango" });
      return z.NEVER;
    }
    return amount;
  });

const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_UNIQUE_VIOLATION = "23505";

function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return pgCode(error) === PG_FOREIGN_KEY_VIOLATION;
}

export function isUniqueViolation(error: unknown): boolean {
  return pgCode(error) === PG_UNIQUE_VIOLATION;
}

export function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
