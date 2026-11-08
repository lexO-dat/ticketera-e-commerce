# catalog — eventos, recintos, productos y media

Reemplaza las tablas de catálogo de Supabase (`events`, `event_dates`, `venues`, `venue_sections`,
`venue_seats`, `ticket_types`, `event_metrics`, `newsletter_subscribers`) y el CDN de imágenes del prototipo (RF03, RF04, RF13, RF14).
Contrato: [`packages/contracts/openapi/catalog.yaml`](../../packages/contracts/openapi/catalog.yaml).
Público a través del gateway: `/catalog/*` → `/v1/*` (lectura) y `/catalog/admin/*` → `/v1/admin/*`.

## Qué resuelve

| Tema               | Decisión                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modelo             | Recinto → sectores (numerados o generales) → butacas. Evento → fechas → un tipo de entrada por sector. En un sector numerado la capacidad es siempre su número de butacas                                                                                                                                                                                                                                          |
| `ItemVendible`     | `POST /v1/items/resolve` devuelve precio, cargo y si se puede vender para cualquier `kind` (`ticket_type`, `product`). Un tipo nuevo se agrega registrando una fuente en `src/items/registry.ts`, sin tocar rutas, `orders` ni `payments` (ASR05)                                                                                                                                                                  |
| Montos             | CLP `bigint` en la BD; string decimal en JSON. Siempre los fija el servidor                                                                                                                                                                                                                                                                                                                                        |
| Autorización       | Reemplaza RLS: `admin` administra todo; `organizer` solo sus eventos; `seller` solo sus productos; recintos solo `admin`. Un recurso ajeno responde 404                                                                                                                                                                                                                                                            |
| Caché (ADR-02)     | Lecturas públicas en Redis con TTL de segundos y **generación**: cada escritura hace `INCR` y todas las réplicas dejan de ver lo anterior al instante. _Single flight_ por clave contra estampidas. Si Redis cae, se lee de Postgres. Más `Cache-Control` corto                                                                                                                                                    |
| Media (ADR-09)     | Subida multipart (máx. 8 MB), decodificada y re-codificada a WebP sin metadatos con `sharp` (rechaza archivos falsos, SVG y bombas de descompresión). Guardada en Postgres, deduplicada por hash, servida con caché inmutable y cacheada en Nginx                                                                                                                                                                  |
| Eventos de dominio | Outbox: `EventoActualizado` (estado completo con fechas y tipos de entrada), `EventoEliminado`, `ProductoActualizado`, `ProductoEliminado`                                                                                                                                                                                                                                                                         |
| Integridad         | Un sector con entradas publicadas no se borra ni regenera sus butacas; una fecha con entradas no cambia de recinto; un recinto con fechas no se borra (409)                                                                                                                                                                                                                                                        |
| Disponibilidad     | Vendidos y reservas no viven aquí: son de `inventory` (Fase 4)                                                                                                                                                                                                                                                                                                                                                     |
| Embudo de ventas   | `POST /v1/events/:id/views` acumula vistas en Redis (`HINCRBY`) y un job con lock las vuelca en lotes cada `METRICS_FLUSH_SECONDS`; reservas, checkouts y compras llegan por eventos (`ReservaCreada`, `OrdenCreada`, `OrdenConfirmada`, inbox idempotente). Agregado diario en `event_metrics` (hora de Chile); `GET /v1/admin/metrics` con alcance por dueño. Los montos vienen de `orders`, nunca del navegador |
| Newsletter         | `POST /v1/newsletter`: correo normalizado, misma respuesta si ya existía (no revela suscriptores); rate limit por IP en el gateway                                                                                                                                                                                                                                                                                 |

## Datos de demostración

`SEED_DEMO_DATA=true` carga [`seed/demo.sql`](seed/demo.sql) si el catálogo está vacío: los recintos,
sectores, eventos y fechas del prototipo (seed de Supabase) con sus mismos UUID, butacas y tipos
de entrada con UUID deterministas, y tres productos de ejemplo. Docker Compose lo activa por defecto
(`CATALOG_SEED_DEMO_DATA`).

## Desarrollo

```bash
npm run infra:up                          # ya incluye catalog (2 réplicas)
# o local con recarga:
cp services/catalog/.env.example services/catalog/.env
npm run dev -w @services/catalog          # http://localhost:3002
```

## Pruebas

```bash
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 \
  npm test -w @services/catalog
```
