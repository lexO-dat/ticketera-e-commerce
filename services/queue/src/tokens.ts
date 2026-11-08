import {
  ADMISSION_TOKEN_AUDIENCE,
  ADMISSION_TOKEN_ISSUER,
  ADMISSION_TOKEN_TYPE,
} from "@shared/commons/auth";
import { type CryptoKey, type JWK, SignJWT, exportJWK, importPKCS8 } from "jose";
import { createPublicKey } from "node:crypto";

/**
 * Firma los tokens de admisión (EdDSA). La clave privada llega por variable de entorno (la misma
 * en todas las réplicas); la pública se publica como JWKS para gateway, inventory y orders.
 */
export interface AdmissionSigner {
  sign(claims: {
    userId: string;
    eventId: string;
    jti: string;
    expiresAt: number;
  }): Promise<string>;
  jwks(): { keys: JWK[] };
}

export async function createAdmissionSigner(pem: string, kid: string): Promise<AdmissionSigner> {
  const privateKey: CryptoKey = await importPKCS8(pem, "EdDSA");
  const publicJwk = await exportJWK(createPublicKey(pem));
  const jwks = { keys: [{ ...publicJwk, kid, alg: "EdDSA", use: "sig" }] };
  return {
    sign: ({ userId, eventId, jti, expiresAt }) =>
      new SignJWT({ evt: eventId })
        .setProtectedHeader({ alg: "EdDSA", kid, typ: ADMISSION_TOKEN_TYPE })
        .setIssuer(ADMISSION_TOKEN_ISSUER)
        .setAudience(ADMISSION_TOKEN_AUDIENCE)
        .setSubject(userId)
        .setJti(jti)
        .setIssuedAt()
        .setExpirationTime(Math.floor(expiresAt / 1000))
        .sign(privateKey),
    jwks: () => jwks,
  };
}
