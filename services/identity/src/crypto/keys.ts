import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ACCESS_TOKEN_ALGORITHM } from "@shared/commons/auth";
import { type Pool, withTransaction } from "@shared/commons/db";
import type { Logger } from "@shared/commons";
import {
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
} from "jose";

/**
 * Claves de firma EdDSA (Ed25519) de los tokens de acceso.
 * - La privada se guarda cifrada con AES-256-GCM (clave maestra en KEY_ENCRYPTION_SECRET).
 * - La clave activa rota cada `maxAgeDays`; las retiradas siguen en el JWKS mientras haya tokens
 *   vigentes firmados con ellas.
 * - Varias réplicas comparten las claves vía la BD; la creación se serializa con un advisory lock.
 */

const KEY_LOCK = 7_340_112_101n;

interface KeyRow {
  kid: string;
  public_jwk: JWK;
  private_key_enc: string;
  created_at: Date;
  retired_at: Date | null;
}

export interface ActiveKey {
  kid: string;
  privateKey: CryptoKey;
}

export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string, masterKey: Buffer): string {
  const [version, iv, tag, data] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !data)
    throw new Error("Formato de clave cifrada desconocido");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString(
    "utf8",
  );
}

export interface KeyStoreOptions {
  pool: Pool;
  masterKey: Buffer;
  maxAgeDays: number;
  /** Cuánto se publica una clave retirada: al menos la vida del token de acceso. */
  retiredGraceSeconds: number;
  logger?: Logger;
}

export class KeyStore {
  private active: ActiveKey | undefined;
  private publicKeys = new Map<string, JWK>();
  private importedPublic = new Map<string, CryptoKey>();
  private loadedAt = 0;
  private static readonly RELOAD_MS = 60_000;

  constructor(private readonly options: KeyStoreOptions) {}

  /** Garantiza una clave activa no vencida (crea o rota si hace falta) y recarga la caché. */
  async ensureActiveKey(): Promise<void> {
    await withTransaction(this.options.pool, async (client) => {
      await client.query("select pg_advisory_xact_lock($1)", [KEY_LOCK]);
      const { rows } = await client.query<{ kid: string; created_at: Date }>(
        "select kid, created_at from signing_keys where retired_at is null order by created_at desc limit 1",
      );
      const current = rows[0];
      const maxAgeMs = this.options.maxAgeDays * 86_400_000;
      if (current && Date.now() - current.created_at.getTime() < maxAgeMs) return;

      const { publicKey, privateKey } = await generateKeyPair(ACCESS_TOKEN_ALGORITHM, {
        crv: "Ed25519",
        extractable: true,
      });
      const publicJwk = await exportJWK(publicKey);
      const kid = await calculateJwkThumbprint(publicJwk);
      const pkcs8 = await exportPKCS8(privateKey);
      await client.query("update signing_keys set retired_at = now() where retired_at is null");
      await client.query(
        "insert into signing_keys (kid, public_jwk, private_key_enc) values ($1, $2, $3)",
        [
          kid,
          JSON.stringify({ ...publicJwk, kid, alg: ACCESS_TOKEN_ALGORITHM, use: "sig" }),
          encryptSecret(pkcs8, this.options.masterKey),
        ],
      );
      this.options.logger?.info({ kid }, "nueva clave de firma activa");
    });
    await this.reload();
  }

  /** Clave con la que se firman los tokens nuevos. */
  async current(): Promise<ActiveKey> {
    await this.reloadIfStale();
    if (!this.active) throw new Error("No hay clave de firma activa");
    return this.active;
  }

  /** Documento JWKS público. */
  async jwks(): Promise<{ keys: JWK[] }> {
    await this.reloadIfStale();
    return { keys: [...this.publicKeys.values()] };
  }

  /** Resolución de clave para `jwtVerify` (el propio identity verifica sus tokens). */
  readonly getKey: JWTVerifyGetKey = async (header) => {
    await this.reloadIfStale();
    const kid = header.kid;
    if (!kid || header.alg !== ACCESS_TOKEN_ALGORITHM) throw new Error("kid o alg inválido");
    let key = this.importedPublic.get(kid);
    if (!key) {
      const jwk = this.publicKeys.get(kid) ?? (await this.reload(), this.publicKeys.get(kid));
      if (!jwk) throw new Error("kid desconocido");
      key = (await importJWK(jwk, ACCESS_TOKEN_ALGORITHM)) as CryptoKey;
      this.importedPublic.set(kid, key);
    }
    return key;
  };

  private async reloadIfStale(): Promise<void> {
    if (Date.now() - this.loadedAt > KeyStore.RELOAD_MS) await this.reload();
  }

  private async reload(): Promise<void> {
    const { rows } = await this.options.pool.query<KeyRow>(
      `select kid, public_jwk, private_key_enc, created_at, retired_at from signing_keys
        where retired_at is null or retired_at > now() - make_interval(secs => $1)
        order by created_at desc`,
      [this.options.retiredGraceSeconds],
    );
    const publicKeys = new Map<string, JWK>();
    for (const row of rows) publicKeys.set(row.kid, row.public_jwk);
    const activeRow = rows.find((row) => row.retired_at === null);
    if (activeRow && activeRow.kid !== this.active?.kid) {
      const pkcs8 = decryptSecret(activeRow.private_key_enc, this.options.masterKey);
      this.active = {
        kid: activeRow.kid,
        privateKey: await importPKCS8(pkcs8, ACCESS_TOKEN_ALGORITHM),
      };
    }
    this.publicKeys = publicKeys;
    for (const kid of this.importedPublic.keys())
      if (!publicKeys.has(kid)) this.importedPublic.delete(kid);
    this.loadedAt = Date.now();
  }
}
