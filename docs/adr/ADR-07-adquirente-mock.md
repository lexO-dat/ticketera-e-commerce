# ADR-07 · Adquirente detrás de un adapter (Webpay mock)

- **Estado:** Aceptado · **ASR:** ASR04 Seguridad, ASR05 Modificabilidad

## Contexto
Todo debe ser propio salvo la autorización bancaria, que en Chile hace un adquirente (Transbank /
Webpay). No tenemos ni queremos credenciales reales en el proyecto.

## Decisión
- `payments` habla con el adquirente solo a través de la interfaz `PaymentProvider`
  (`create`, `commit`, `status`, `refund`).
- Implementación actual: **`webpay-mock`**, un servicio que imita la API y los retornos de Webpay Plus.
  Decide por el email del comprador: `@acceptme.com` aprueba, `@rejectme.com` rechaza, otro dominio
  rechaza con `UNSUPPORTED_TEST_EMAIL` (configurable).
- Es el **único mock** del sistema; todo lo demás (idempotencia, ledger, reembolsos, conciliación) es real.

Detalle: [`docs/services/payments.md`](../services/payments.md).

## Consecuencias
- (+) Pasar a Webpay real es configuración + un adapter, sin tocar el dominio.
- (−) El mock no ejercita la red ni los tiempos reales de Transbank; se compensa con modos de falla
  simulados (latencia, respuesta perdida, 5xx).
