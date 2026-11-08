# webpay-mock — adquirente simulado

**Único mock del sistema** ([ADR-07](../../docs/adr/ADR-07-adquirente-mock.md)). Imita la API REST
de Webpay Plus v1.2 de Transbank y su formulario de pago, con el mismo formato de respuestas y
errores. Contrato: [`packages/contracts/openapi/webpay-mock.yaml`](../../packages/contracts/openapi/webpay-mock.yaml).

| Email del comprador (`X-Mock-Payer-Email`) | Resultado del commit                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `*@acceptme.com`                           | `AUTHORIZED`, `response_code: 0`, tarjeta `6623`                                |
| `*@rejectme.com`                           | `FAILED`, `response_code: -1`                                                   |
| otro dominio                               | `FAILED`, `mock_reason: UNSUPPORTED_TEST_EMAIL` (`WEBPAY_MOCK_DEFAULT_OUTCOME`) |

- Flujo real: `create` → el navegador va a `/webpay/form?token_ws=…` (botones **Pagar** y **Anular**)
  → vuelve a la `return_url` con `token_ws` o con `TBK_TOKEN` / `TBK_ORDEN_COMPRA` → `commit`.
- El commit se acepta **una sola vez** y solo después de "Pagar" (si no, 422 como Transbank).
- Reembolsos: reversa (total, mismo día) o anulación total/parcial con saldo.
- Modos de falla para pruebas de resiliencia: `WEBPAY_MOCK_LATENCY_MS`,
  `WEBPAY_MOCK_COMMIT_LOSS_RATIO` (procesa el commit pero "pierde" la respuesta → conciliación),
  `WEBPAY_MOCK_ERROR_RATIO`.
- Estado en Redis (TTL 24 h). En compose se publica en `127.0.0.1:3005` y el formulario se ve en
  `https://localhost:8443/webpay/form`.

```bash
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 npm test -w @services/webpay-mock
```
