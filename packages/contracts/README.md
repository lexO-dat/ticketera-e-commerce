# @shared/contracts

Contratos versionados entre servicios (ADR-05). Un servicio no lee la base de otro: se comunica por
HTTP (OpenAPI) o eventos (AsyncAPI).

- `openapi/common.yaml` — componentes comunes: `Problem` (RFC 9457), health checks, `x-request-id`,
  `Idempotency-Key`, `Money` (CLP como string entero).
- `openapi/<servicio>.yaml` — contrato HTTP de cada servicio (listado en `HttpServices`).
- `asyncapi/events.yaml` — eventos de dominio: canal `<source>.<Tipo>.v<version>` en el exchange
  `ticketera.events`, sobre común y `data` de cada evento.
- `src/index.ts` — catálogo `DomainEvents`, `routingKey()` y `bindingFor()` para publicar y suscribirse.

Reglas: un cambio incompatible crea una versión nueva (ruta `/v2` o evento `.v2`) que convive con la
anterior. `npm test -w @shared/contracts` valida los OpenAPI y que el catálogo coincida con AsyncAPI.
