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
  config: Pick<
    Config,
    | "IDENTITY_URLS"
    | "CATALOG_URLS"
    | "QUEUE_URLS"
    | "INVENTORY_URLS"
    | "ORDERS_URLS"
    | "PAYMENTS_URLS"
    | "TICKETS_URLS"
  >,
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
    // Fila virtual (ADR-06) y reservas (ADR-03). Los servicios exigen sesión y, con fila, el turno.
    {
      prefix: "/queue/admin",
      upstreams: config.QUEUE_URLS,
      rewritePrefix: "/v1/admin",
      roles: ["admin"],
    },
    { prefix: "/queue", upstreams: config.QUEUE_URLS, rewritePrefix: "/v1" },
    {
      prefix: "/inventory/admin",
      upstreams: config.INVENTORY_URLS,
      rewritePrefix: "/v1/admin",
      roles: ["admin"],
    },
    { prefix: "/inventory", upstreams: config.INVENTORY_URLS, rewritePrefix: "/v1" },
    // Carro, checkout y órdenes; pagos (el retorno del adquirente es público, sin sesión).
    {
      prefix: "/orders/admin",
      upstreams: config.ORDERS_URLS,
      rewritePrefix: "/v1/admin",
      roles: ["admin"],
    },
    { prefix: "/orders", upstreams: config.ORDERS_URLS, rewritePrefix: "/v1" },
    {
      prefix: "/payments/admin",
      upstreams: config.PAYMENTS_URLS,
      rewritePrefix: "/v1/admin",
      roles: ["admin"],
    },
    { prefix: "/payments", upstreams: config.PAYMENTS_URLS, rewritePrefix: "/v1" },
    // Entradas; la validación en puerta exige rol de personal en el servicio.
    { prefix: "/tickets", upstreams: config.TICKETS_URLS, rewritePrefix: "/v1" },
  ];
}
