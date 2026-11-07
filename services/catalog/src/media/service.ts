import { AppError, ErrorCode, newId, sha256Hex } from "@shared/commons";
import type { Pool } from "@shared/commons/db";
import sharp from "sharp";
import type { Actor } from "../shared.js";

/**
 * Media propia (reemplaza el CDN de Lovable / Supabase Storage).
 *
 * Toda imagen subida se **decodifica y vuelve a codificar** como WebP: así se descartan metadatos
 * (EXIF con GPS), archivos políglotas y formatos no soportados, sin confiar en la extensión ni en
 * el `Content-Type` que manda el cliente. Las imágenes se guardan en Postgres (`bytea`): quedan en
 * la réplica síncrona con el resto del catálogo (failover sin volumen compartido, ADR-01) y se
 * sirven con caché inmutable (el id nunca cambia de contenido).
 */

const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp", "avif", "gif"]);
/** Límite de píxeles al decodificar: evita "bombas" de descompresión. */
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_DIMENSION = 2400;
const WEBP_QUALITY = 82;

export interface StoredMedia {
  id: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  url: string;
}

export interface MediaFile {
  id: string;
  sha256: string;
  contentType: string;
  data: Buffer;
}

export interface MediaService {
  upload(actor: Actor, input: Buffer): Promise<StoredMedia>;
  get(id: string): Promise<MediaFile | undefined>;
  exists(id: string): Promise<boolean>;
  url(id: string): string;
}

export async function processImage(
  input: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  let format: string | undefined;
  try {
    ({ format } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata());
  } catch {
    throw invalidImage("El archivo no es una imagen válida");
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw invalidImage("Formato no soportado: usa JPEG, PNG, WebP, AVIF o GIF");
  }
  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
      // GIF/WebP animados: solo el primer cuadro.
      animated: false,
    })
      .rotate() // respeta la orientación EXIF antes de descartarla
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw invalidImage("No se pudo procesar la imagen");
  }
}

function invalidImage(detail: string): AppError {
  return new AppError(ErrorCode.VALIDATION, undefined, {
    detail,
    reason: "INVALID_IMAGE",
    issues: [{ path: "file", message: detail }],
  });
}

export function createMediaService(options: { pool: Pool; publicPath: string }): MediaService {
  const { pool, publicPath } = options;
  const url = (id: string) => `${publicPath}/${id}`;

  return {
    url,

    async upload(actor, input) {
      const image = await processImage(input);
      const sha256 = sha256Hex(image.data);
      // Contenido idéntico → mismo registro (la imagen es inmutable y pública).
      const result = await pool.query<{ id: string }>(
        `insert into media (id, sha256, content_type, bytes, width, height, data, uploaded_by)
         values ($1, $2, 'image/webp', $3, $4, $5, $6, $7)
         on conflict (sha256) do update set sha256 = excluded.sha256
         returning id`,
        [newId(), sha256, image.data.length, image.width, image.height, image.data, actor.id],
      );
      const id = result.rows[0]!.id;
      return {
        id,
        contentType: "image/webp",
        bytes: image.data.length,
        width: image.width,
        height: image.height,
        url: url(id),
      };
    },

    async get(id) {
      const result = await pool.query<{
        id: string;
        sha256: string;
        content_type: string;
        data: Buffer;
      }>("select id, sha256, content_type, data from media where id = $1", [id]);
      const row = result.rows[0];
      return row
        ? { id: row.id, sha256: row.sha256, contentType: row.content_type, data: row.data }
        : undefined;
    },

    async exists(id) {
      const result = await pool.query("select 1 from media where id = $1", [id]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
