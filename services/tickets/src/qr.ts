import { createPublicKey } from "node:crypto";
import { type CryptoKey, type JWK, SignJWT, exportJWK, importPKCS8, jwtVerify } from "jose";

/**
 * Contenido del QR: token compacto firmado con EdDSA (`typ: ticket+jwt`, `tid` = entrada,
 * `evd` = función). Imposible de falsificar sin la clave privada, y verificable con el JWKS
 * público (la app de validación puede comprobar la firma). No se guarda: se genera al pedirlo.
 * Que la entrada siga vigente (no usada ni anulada) lo decide siempre la base al validar.
 */
export const TICKET_TOKEN_TYPE = "ticket+jwt";
const ISSUER = "ticketera-tickets";

export interface TicketQr {
  sign(ticket: { id: string; eventDateId: string }): Promise<string>;
  verify(token: string): Promise<{ ticketId: string; eventDateId: string } | null>;
  jwks(): { keys: JWK[] };
}

export async function createTicketQr(pem: string, kid: string): Promise<TicketQr> {
  const privateKey: CryptoKey = await importPKCS8(pem, "EdDSA");
  const publicKeyObject = createPublicKey(pem);
  const publicJwk = await exportJWK(publicKeyObject);
  const jwks = { keys: [{ ...publicJwk, kid, alg: "EdDSA", use: "sig" }] };

  return {
    sign: ({ id, eventDateId }) =>
      new SignJWT({ tid: id, evd: eventDateId })
        .setProtectedHeader({ alg: "EdDSA", kid, typ: TICKET_TOKEN_TYPE })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .sign(privateKey),
    async verify(token) {
      try {
        const { payload, protectedHeader } = await jwtVerify(token, publicKeyObject, {
          issuer: ISSUER,
          algorithms: ["EdDSA"],
        });
        if (protectedHeader.typ !== TICKET_TOKEN_TYPE) return null;
        if (typeof payload["tid"] !== "string" || typeof payload["evd"] !== "string") return null;
        return { ticketId: payload["tid"], eventDateId: payload["evd"] };
      } catch {
        return null;
      }
    },
    jwks: () => jwks,
  };
}
