import { createHash } from "node:crypto";
import type { Logger } from "@shared/commons";
import { type Pool, withTransaction } from "@shared/commons/db";
import sharp from "sharp";
import type { ReadCache } from "./cache.js";
import type { MediaService } from "./media/service.js";
import type { Actor } from "./shared.js";

/**
 * Portadas de los datos de demostración. El prototipo no traía imágenes y no se usan bancos de
 * imágenes externos: se genera arte abstracto propio (degradado y figuras según la categoría,
 * determinista por id) y se guarda como cualquier imagen subida (ADR-09). Sin texto: la imagen
 * del contenedor no trae fuentes y el título ya está en la página. Las fotos reales se suben desde
 * el panel y reemplazan a estas.
 */

/** Autor de las imágenes generadas (no es un usuario real). */
const SYSTEM_ACTOR: Actor = { id: "00000000-0000-0000-0000-000000000000", roles: ["admin"] };
const ART_LOCK = 7340112302n;

const PALETTES: Record<string, [string, string, string, string]> = {
  conciertos: ["#14102b", "#5b2a86", "#f15bb5", "#fee440"],
  festivales: ["#0b132b", "#1c7c54", "#f9c80e", "#f86624"],
  teatro: ["#1d0f0f", "#7a1f2b", "#d4a373", "#faedcd"],
  deportes: ["#0a1f44", "#1b6ca8", "#3ddc97", "#f4f4f9"],
  familia: ["#2b2d42", "#ef8354", "#ffd166", "#8ecae6"],
  tienda: ["#1f1f1f", "#3a5a40", "#a3b18a", "#f2e8cf"],
};

function rng(seed: string) {
  const bytes = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => bytes[i++ % bytes.length]! / 255;
}

/** SVG abstracto: degradado de fondo, anillos y círculos, y una banda diagonal. */
export function coverSvg(seed: string, category: string, width: number, height: number): string {
  const [bg, mid, accent, light] = PALETTES[category] ?? PALETTES["conciertos"]!;
  const r = rng(seed);
  const shapes: string[] = [];
  for (let n = 0; n < 7; n++) {
    const cx = Math.round(r() * width);
    const cy = Math.round(r() * height);
    const radius = Math.round((0.08 + r() * 0.32) * Math.min(width, height));
    const color = [mid, accent, light][n % 3];
    shapes.push(
      n % 2 === 0
        ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${color}" opacity="${(0.25 + r() * 0.5).toFixed(2)}"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="${Math.round(6 + r() * 30)}" opacity="${(0.4 + r() * 0.5).toFixed(2)}"/>`,
    );
  }
  const angle = Math.round(-35 + r() * 70);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${mid}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${(0.2 + r() * 0.6).toFixed(2)}" cy="${(0.2 + r() * 0.6).toFixed(2)}" r="0.7">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  ${shapes.join("\n  ")}
  <rect x="${-width}" y="${Math.round(height * (0.35 + r() * 0.3))}" width="${width * 3}" height="${Math.round(height * 0.08)}" fill="${light}" opacity="0.18" transform="rotate(${angle} ${width / 2} ${height / 2})"/>
</svg>`;
}

async function render(seed: string, category: string, width: number, height: number) {
  return sharp(Buffer.from(coverSvg(seed, category, width, height)))
    .png()
    .toBuffer();
}

/**
 * Asigna portada a los eventos y productos de demostración que no tienen imagen. Idempotente
 * (solo toca los que siguen sin imagen) y seguro con varias réplicas arrancando a la vez.
 */
export async function seedDemoImages(deps: {
  pool: Pool;
  media: MediaService;
  cache: ReadCache;
  logger: Logger;
}): Promise<number> {
  const { pool, media, cache, logger } = deps;
  const updated = await withTransaction(pool, async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [ART_LOCK]);
    const events = await client.query<{ id: string; category: string }>(
      "select id, category from events where image_id is null and id::text like 'e0000000-%'",
    );
    const products = await client.query<{ id: string; category: string | null }>(
      `select p.id, e.category from products p left join events e on e.id = p.event_id
        where p.image_id is null and p.id::text like 'b0000000-%'`,
    );
    for (const event of events.rows) {
      const stored = await media.upload(
        SYSTEM_ACTOR,
        await render(event.id, event.category, 1600, 1200),
      );
      await client.query("update events set image_id = $1 where id = $2", [stored.id, event.id]);
    }
    for (const product of products.rows) {
      const stored = await media.upload(
        SYSTEM_ACTOR,
        // Paleta del evento del producto (o la de la tienda si no tiene evento).
        await render(product.id, product.category ?? "tienda", 1200, 1200),
      );
      await client.query("update products set image_id = $1 where id = $2", [
        stored.id,
        product.id,
      ]);
    }
    return events.rowCount! + products.rowCount!;
  });
  if (updated > 0) {
    await cache.invalidate();
    logger.info({ updated }, "portadas de demostración generadas");
  }
  return updated;
}
