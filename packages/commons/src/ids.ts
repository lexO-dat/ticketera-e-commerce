import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** Identificador opaco (UUID v4 generado con CSPRNG). */
export function newId(): string {
  return randomUUID();
}

// Base32 de Crockford: sin I, L, O, U (evita confusiones al leer o dictar un código).
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Código legible y no adivinable (p. ej. `TK-7Q2M9X4F`). Usa `crypto.randomBytes`, nunca
 * `Math.random`. Cada carácter aporta 5 bits: 8 caracteres = 40 bits, 12 = 60 bits.
 */
export function secureCode(length = 10, prefix?: string): string {
  if (!Number.isInteger(length) || length < 4 || length > 64) {
    throw new RangeError("La longitud debe estar entre 4 y 64");
  }
  let code = "";
  // 256 es múltiplo de 32, así que `byte & 31` es uniforme (sin sesgo de módulo).
  for (const byte of randomBytes(length)) code += CROCKFORD[byte & 31];
  return prefix ? `${prefix}-${code}` : code;
}

/** Token aleatorio (refresh tokens, enlaces de verificación) en base64url. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Comparación en tiempo constante (compara hashes para no filtrar la longitud). */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
