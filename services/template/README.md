# template — plantilla de servicio

Base para crear cada microservicio (`npm run new:service -- <nombre>`). Es un servicio real y
probado: un recurso de ejemplo (`notes`) que muestra el patrón que todos siguen.

| Aspecto       | Cómo se resuelve                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| HTTP          | Fastify vía `createServer` de `@shared/commons/http`: `x-request-id`, errores RFC 9457, `GET /health/live` y `GET /health/ready` |
| Capas         | `routes.ts` (controlador, valida con Zod) → `service.ts` (negocio, transacciones) → `repository.ts` (SQL parametrizado)          |
| Datos         | Base propia (`template`) con migraciones SQL versionadas en `migrations/` (se aplican al arrancar, con _advisory lock_)          |
| Eventos       | Outbox en la misma transacción; `OutboxRelay` publica a RabbitMQ; inbox para consumidores idempotentes                           |
| Configuración | Variables de entorno validadas con Zod al arrancar (`src/config.ts`, `.env.example`)                                             |
| Apagado       | `SIGTERM` → `/health/ready` 503 → termina solicitudes en curso → cierra relay, broker, Redis y BD                                |
| Imagen        | `Dockerfile` multi-stage, usuario `node` (no root), solo dependencias de producción                                              |

Contrato HTTP: [`packages/contracts/openapi/template.yaml`](../../packages/contracts/openapi/template.yaml).

## Desarrollo

```bash
npm run infra:up                       # desde la raíz
cp services/template/.env.example services/template/.env
npm run dev -w @services/template      # http://localhost:3900
```

## Pruebas

```bash
npm test -w @services/template                                  # unitarias
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
  npm test -w @services/template                                # + integración con Postgres
```

## Imagen

```bash
docker compose -f infra/docker-compose.yml --profile template up -d --build template
curl http://localhost:3900/health/ready
```
