import { randomBytes } from "node:crypto";
import { AppError } from "@shared/commons";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/crypto/keys.js";
import {
  assertPasswordPolicy,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "../src/crypto/passwords.js";

describe("contraseñas", () => {
  it("hashea con Argon2id y parámetros OWASP", async () => {
    const hash = await hashPassword("una-clave-larga-y-rara");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(needsRehash(hash)).toBe(false);
    expect(await verifyPassword(hash, "una-clave-larga-y-rara")).toBe(true);
    expect(await verifyPassword(hash, "otra")).toBe(false);
    expect(await verifyPassword("no-es-un-hash", "x")).toBe(false);
  });

  it("detecta hashes con parámetros antiguos", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA")).toBe(true);
  });

  it("aplica la política", () => {
    expect(() => assertPasswordPolicy("corta")).toThrow(AppError);
    expect(() => assertPasswordPolicy("password123")).toThrow(AppError);
    expect(() => assertPasswordPolicy("aaaaaaaaaaaa")).toThrow(AppError);
    expect(() => assertPasswordPolicy("ana@correo.cl", "ana@correo.cl")).toThrow(AppError);
    expect(() => assertPasswordPolicy("x".repeat(129))).toThrow(AppError);
    expect(() => assertPasswordPolicy("caballo correcto batería grapa")).not.toThrow();
  });
});

describe("cifrado de claves privadas", () => {
  it("cifra y descifra con AES-256-GCM y detecta manipulación", () => {
    const key = randomBytes(32);
    const sealed = encryptSecret("-----BEGIN PRIVATE KEY-----", key);
    expect(sealed).not.toContain("PRIVATE");
    expect(decryptSecret(sealed, key)).toBe("-----BEGIN PRIVATE KEY-----");
    const parts = sealed.split(".");
    parts[3] = Buffer.from("manipulado").toString("base64");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
  });
});
