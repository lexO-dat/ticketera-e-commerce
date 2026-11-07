import { hash, verify } from "@node-rs/argon2";
import { AppError, randomToken } from "@shared/commons";

/**
 * Argon2id con los parámetros mínimos recomendados por OWASP (m = 19 MiB, t = 2, p = 1).
 * Si se suben, los hashes antiguos se recalculan en el siguiente login exitoso.
 */
const ARGON2ID = 2; // Algorithm.Argon2id (const enum del paquete)
export const PASSWORD_HASH_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 10;
// Argon2 acepta entradas largas, pero hashear megabytes es una vía de DoS.
export const PASSWORD_MAX_LENGTH = 128;

const COMMON_PASSWORDS = new Set([
  "1234567890",
  "12345678910",
  "123456789012",
  "contraseña",
  "contrasena123",
  "password123",
  "password1234",
  "qwertyuiop",
  "1q2w3e4r5t",
  "iloveyou123",
  "ticketera123",
  "administrador",
]);

export function hashPassword(password: string): Promise<string> {
  return hash(password, PASSWORD_HASH_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** `true` si el hash usa parámetros distintos (más débiles o antiguos) a los vigentes. */
export function needsRehash(passwordHash: string): boolean {
  const { memoryCost, timeCost, parallelism } = PASSWORD_HASH_OPTIONS;
  return !passwordHash.startsWith(`$argon2id$v=19$m=${memoryCost},t=${timeCost},p=${parallelism}$`);
}

// Hash de una contraseña aleatoria: se verifica contra él cuando el email no existe, para que el
// tiempo de respuesta no revele qué cuentas existen.
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomToken(24));
  return dummyHash;
}

/** Política de contraseñas (NIST 800-63B: largo mínimo y lista de comunes, sin reglas de composición). */
export function assertPasswordPolicy(password: string, email?: string): void {
  const issues: { path: string; message: string }[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push({
      path: "password",
      message: `Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    issues.push({
      path: "password",
      message: `Debe tener como máximo ${PASSWORD_MAX_LENGTH} caracteres`,
    });
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered) || /^(.)\1+$/.test(password)) {
    issues.push({ path: "password", message: "Es demasiado común; elige otra" });
  }
  if (email && lowered === email.toLowerCase()) {
    issues.push({ path: "password", message: "No puede ser igual al email" });
  }
  if (issues.length > 0) throw AppError.validation(issues, "La contraseña no cumple la política");
}
