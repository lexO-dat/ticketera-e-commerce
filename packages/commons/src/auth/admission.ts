import {
  type JWTPayload,
  type JWTVerifyGetKey,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import { AppError, ErrorCode } from "../errors.js";

/**
 * Token de admisión de la fila virtual (ADR-06): lo emite `queue` cuando le toca al comprador y lo
 * exigen gateway, `inventory` y `orders` en eventos con fila. Ligado a usuario (`sub`) y evento
 * (`evt`); su `jti` vive en Redis mientras dura la ventana (se puede revocar).
 */
export const ADMISSION_TOKEN_ISSUER = "ticketera-queue";
export const ADMISSION_TOKEN_AUDIENCE = "ticketera";
export const ADMISSION_TOKEN_TYPE = "admission+jwt";
export const ADMISSION_HEADER = "x-admission-token";

/** Clave Redis del `jti` vigente (la escribe `queue`; la leen inventory y orders). */
export function admissionJtiKey(eventId: string, jti: string): string {
  return `q:{${eventId}}:jti:${jti}`;
}

export interface AdmissionClaims extends JWTPayload {
  sub: string;
  evt: string;
  jti: string;
}

export interface Admission {
  userId: string;
  eventId: string;
  jti: string;
  expiresAt: Date;
}

export type AdmissionVerifier = (token: string) => Promise<Admission>;

export function createAdmissionVerifier(options: {
  jwksUrl?: string | URL;
  getKey?: JWTVerifyGetKey;
}): AdmissionVerifier {
  const getKey =
    options.getKey ??
    (options.jwksUrl
      ? createRemoteJWKSet(new URL(options.jwksUrl), {
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
          timeoutDuration: 3_000,
        })
      : undefined);
  if (!getKey) throw new Error("createAdmissionVerifier requiere jwksUrl o getKey");

  return async (token) => {
    try {
      const { payload, protectedHeader } = await jwtVerify<AdmissionClaims>(token, getKey, {
        issuer: ADMISSION_TOKEN_ISSUER,
        audience: ADMISSION_TOKEN_AUDIENCE,
        algorithms: ["EdDSA"],
        clockTolerance: 5,
        requiredClaims: ["sub", "evt", "jti", "exp"],
      });
      if (protectedHeader.typ !== ADMISSION_TOKEN_TYPE) throw new Error("typ inválido");
      return {
        userId: payload.sub,
        eventId: payload.evt,
        jti: payload.jti,
        expiresAt: new Date(payload.exp! * 1000),
      };
    } catch (error) {
      if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
        throw AppError.unavailable("No se pudo verificar el turno de la fila");
      }
      throw admissionRequired(
        error instanceof joseErrors.JWTExpired
          ? "Tu ventana de compra venció; vuelve a la fila"
          : "Turno de la fila inválido",
      );
    }
  };
}

/** 403 con motivo estable para que el cliente vuelva a la sala de espera. */
export function admissionRequired(
  detail = "Este evento tiene fila virtual: espera tu turno",
): AppError {
  return new AppError(ErrorCode.FORBIDDEN, undefined, { detail, reason: "ADMISSION_REQUIRED" });
}
