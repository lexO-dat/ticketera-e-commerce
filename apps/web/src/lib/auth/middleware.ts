import { createMiddleware } from "@tanstack/react-start";

/**
 * Exige sesión en una server function (reemplaza a `requireSupabaseAuth`). Deja en el contexto
 * el usuario, sus roles y el token de acceso para llamar al gateway en su nombre.
 */
export const requireAuth = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { currentAuth } = await import("./session.server");
  const auth = await currentAuth();
  if (!auth) throw new Error("Unauthorized: inicia sesión para continuar");
  return next({ context: auth });
});
