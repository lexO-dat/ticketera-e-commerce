import type { Role } from "@shared/commons/auth";
import type { Config } from "./config.js";

/**
 * Tabla de enrutamiento pública → servicio interno (vista de desarrollo). Cada fase agrega sus
 * servicios aquí. `roles` exige token válido con alguno de esos roles ya en el gateway; los
 * servicios vuelven a verificar el token y la propiedad de cada recurso (defensa en profundidad).
 */
export interface UpstreamRoute {
  prefix: string;
  upstreams: string[];
  rewritePrefix: string;
  roles?: Role[];
}

export function upstreamRoutes(
  config: Pick<Config, "IDENTITY_URLS" | "CATALOG_URLS">,
): UpstreamRoute[] {
  return [
    { prefix: "/auth", upstreams: config.IDENTITY_URLS, rewritePrefix: "/v1/auth" },
    {
      prefix: "/admin/users",
      upstreams: config.IDENTITY_URLS,
      rewritePrefix: "/v1/admin/users",
      roles: ["admin"],
    },
    { prefix: "/.well-known", upstreams: config.IDENTITY_URLS, rewritePrefix: "/.well-known" },
    // Administración del catálogo: el servicio además restringe por rol y dueño de cada recurso.
    {
      prefix: "/catalog/admin",
      upstreams: config.CATALOG_URLS,
      rewritePrefix: "/v1/admin",
      roles: ["admin", "organizer", "seller"],
    },
    // Lectura pública (cacheada en catalog) e ItemVendible.
    { prefix: "/catalog", upstreams: config.CATALOG_URLS, rewritePrefix: "/v1" },
  ];
}
