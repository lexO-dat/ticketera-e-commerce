# payments — pagos

Implementa [`docs/services/payments.md`](../../docs/services/payments.md) (RF09, ADR-04, ADR-07).
Reemplaza el `createOrder` del prototipo que marcaba la orden como pagada sin cobrar. Contrato:
[`packages/contracts/openapi/payments.yaml`](../../packages/contracts/openapi/payments.yaml).

| Tema               | Implementación                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monto              | Siempre de `orders` (`GET /internal/orders/:id`); nunca del cliente. Máximo por orden y máximo de intentos por orden (antifraude)                                                               |
| Idempotencia       | `Idempotency-Key` obligatoria en cada POST (tabla `idempotency_keys`): misma clave → misma respuesta; otra solicitud → 422. Un solo intento vivo por orden (índice único parcial)               |
| Máquina de estados | `CREATED → PENDING → AUTHORIZED / FAILED / CANCELED / EXPIRED / UNKNOWN → REFUND_PENDING → (PARTIALLY_)REFUNDED`, con compare-and-set y auditoría de cada transición (`payment_attempt_events`) |
| Adquirente         | Interfaz `PaymentProvider` (`create`, `commit`, `status`, `refund`); hoy `webpay-mock`. Pasar a Webpay real = configuración + adapter                                                           |
| Retorno            | `GET /v1/return` (público): commit **una sola vez** con lock de fila; el resultado sale solo del adquirente. Maneja `token_ws`, `TBK_TOKEN` (anulación) y timeout. Redirige a la orden          |
| Ledger             | Doble entrada, append-only (trigger que impide UPDATE/DELETE): cobro `customer_payments −`, `merchant_payable +`, `platform_fees +`; reembolso `customer_payments +`, `refunds −`               |
| Eventos            | Outbox en la misma transacción: `PagoAutorizado`, `PagoRechazado` (motivo), `PagoReembolsado`                                                                                                   |
| Jobs (lock Redis)  | Expirador 30 s (PENDING vencidos → `status` → EXPIRED o AUTHORIZED tardío), conciliador 1 min (UNKNOWN → `status`), cierre horario del ledger                                                   |
| Datos de tarjeta   | Nunca: el formulario vive en el adquirente. Solo últimos 4 dígitos y tipo de pago                                                                                                               |

```bash
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
TEST_REDIS_URL=redis://:redis-dev-password@127.0.0.1:6379 npm test -w @services/payments
```
