/**
 * Verifica el rol admin con los roles del token de identity (ya verificado por `requireAuth`).
 * Reemplaza a `has_role` + RLS de Supabase.
 */
export function assertAdmin(roles: readonly string[]) {
  if (!roles.includes("admin")) throw new Error("Forbidden");
  return true;
}
