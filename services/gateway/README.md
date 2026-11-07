# gateway — API Gateway

Entrada única al backend (ADR-05), detrás de Nginx (`https://localhost:8443/api/*`).
Contrato: [`packages/contracts/openapi/gateway.yaml`](../../packages/contracts/openapi/gateway.yaml).

| Responsabilidad   | Implementación                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrutamiento      | Tabla en `src/routes.ts` (prefijo público → servicio interno). Round-robin entre réplicas; 503/504 problem+json si el servicio no responde                                                                                                     |
| Autenticación     | Si llega `Authorization: Bearer`, se verifica con el JWKS de identity (caché, rotación, tolerante a réplicas caídas); inválido → 401 sin tocar el servicio. Rutas con `roles` exigen además el rol. Los servicios vuelven a verificar el token |
| Rate limiting     | Ventana fija en Redis compartida por todas las réplicas: login 10/min, registro y recuperación 5/10 min, refresh 60/min por IP; general 300/min por usuario. 429 con `Retry-After`                                                             |
| CORS / CSRF       | API solo-Bearer: descarta cookies, así que no aplica CSRF. CORS solo para `CORS_ORIGINS`                                                                                                                                                       |
| Trazabilidad      | `x-request-id` (de Nginx o generado) propagado a los servicios; `X-Forwarded-For` con la IP real (solo desde proxies de confianza)                                                                                                             |
| Anti-suplantación | Descarta cabeceras internas (`x-user-id`, `x-user-roles`, …) que mande el cliente                                                                                                                                                              |

Agregar un servicio: una entrada en `src/routes.ts`, su URL en `config.ts` / compose y su contrato.

```bash
cp services/gateway/.env.example services/gateway/.env
npm run dev -w @services/gateway          # http://localhost:3000
npm test -w @services/gateway
```
