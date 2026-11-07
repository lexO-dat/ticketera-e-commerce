# ADR-04 · Seguridad en capas

- **Estado:** Aceptado · **ASR:** ASR04 Seguridad

## Contexto
TLS 1.3 en tránsito; credenciales protegidas en reposo con algoritmos estándar; sin accesos ni
modificaciones no autorizadas en la compra.

## Decisión
- **TLS 1.3** de punta a punta (borde y tráfico hacia el adquirente; mTLS opcional entre servicios).
- **Pago tokenizado** en el proveedor (no tocamos datos de tarjeta) con **clave de idempotencia**.
- **OAuth 2.0 / JWT con roles**, emitidos por `identity` (propio): access token EdDSA de vida corta,
  refresh token opaco rotativo y revocable, JWKS para que gateway y servicios verifiquen.
- Contraseñas con **Argon2id**.
- Autorización explícita por rol y propiedad en cada servicio (reemplaza a la RLS de Supabase).

## Consecuencias
- (+) Defensa en profundidad; sin dependencia de un proveedor de identidad externo.
- (−) Cifrar y validar cada transacción agrega carga: algo menos de rendimiento.
