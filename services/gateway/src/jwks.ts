import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

/**
 * JWKS de identity con tolerancia a fallos: si una réplica no responde, prueba la siguiente.
 * Cada conjunto remoto cachea las claves y se refresca solo ante un `kid` desconocido (rotación).
 */
export function replicatedJwks(baseUrls: string[]): JWTVerifyGetKey {
  const sets = baseUrls.map((base) =>
    createRemoteJWKSet(new URL("/.well-known/jwks.json", base), {
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      timeoutDuration: 3_000,
    }),
  );
  return async (header, token) => {
    let lastError: unknown;
    for (const getKey of sets) {
      try {
        return await getKey(header, token);
      } catch (error) {
        lastError = error;
        // Un kid inexistente o una firma inválida no se arreglan preguntando a otra réplica.
        if (
          error instanceof Error &&
          /no applicable key|JWKSNoMatchingKey|multiple matching/i.test(
            `${error.name} ${error.message}`,
          )
        ) {
          throw error;
        }
      }
    }
    throw lastError;
  };
}
