# ADR-08 · Sesión web con BFF y cookies HttpOnly

- **Estado:** Aceptado · **ASR:** ASR04 Seguridad · Complementa ADR-04

## Contexto

El prototipo guardaba la sesión de Supabase en `localStorage`: cualquier XSS podía robar los tokens.
Con `identity` (Fase 2) hay que decidir dónde vive la sesión del navegador.

## Decisión

- La web (TanStack Start) actúa como **BFF**: sus server functions llaman al gateway; el navegador
  nunca recibe los tokens.
- Token de acceso en cookie `tk_at` (`HttpOnly; Secure; SameSite=Lax`, 15 min) y refresh token en
  `tk_rt` (`HttpOnly; Secure; SameSite=Strict`). El servidor verifica el JWT con el JWKS y renueva
  la sesión de forma transparente cuando el acceso vence.
- CSRF: las server functions conservan el middleware CSRF de TanStack Start; el gateway es
  solo-Bearer y descarta cookies, así que no es atacable por CSRF.
- La web reenvía la IP del cliente (`X-Forwarded-For`) para que los límites por IP del gateway
  apliquen al usuario y no al servidor web.

## Consecuencias

- (+) Un XSS no puede exfiltrar tokens; refresh rotativo con detección de reutilización (identity).
- (+) Clientes no web (app de validación, simulador) usan el mismo API con Bearer.
- (−) Toda llamada autenticada pasa por el servidor web (un salto más). Aceptable: las lecturas
  públicas siguen cacheadas (ADR-02).
- (−) Dos solicitudes paralelas con el acceso vencido pueden competir por el refresh; la perdedora
  queda anónima en esa solicitud (sin cerrar la sesión) y la siguiente usa las cookies nuevas.
