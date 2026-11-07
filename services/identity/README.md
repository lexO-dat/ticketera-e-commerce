# identity — cuentas, sesiones y roles

Reemplaza a Supabase Auth, `user_roles`/`has_role` (RLS) y `auth.admin.*` (RF01, RF02, ADR-04).
Contrato: [`packages/contracts/openapi/identity.yaml`](../../packages/contracts/openapi/identity.yaml).
Público solo a través del gateway (`/auth/*`, `/admin/users*`, `/.well-known/jwks.json`).

## Seguridad

| Tema                  | Decisión                                                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contraseñas           | Argon2id (m = 19 MiB, t = 2, p = 1, OWASP); se re-hashean al iniciar sesión si cambian los parámetros. Política NIST: 10–128 caracteres, sin comunes, distinta del email                                   |
| Enumeración           | Registro y "olvidé mi contraseña" responden igual exista o no la cuenta; login con email inexistente verifica contra un hash señuelo (mismo tiempo) y devuelve el mismo error                              |
| Fuerza bruta          | Bloqueo temporal de la cuenta tras N fallos (contador atómico en BD) + límites por IP en el gateway                                                                                                        |
| Token de acceso       | JWT EdDSA (Ed25519), 15 min, `iss`/`aud`/`sub`/`roles`/`email_verified`/`sid`/`jti`. Verificable por cualquiera con el JWKS                                                                                |
| Claves de firma       | Generadas por el servicio, privadas cifradas en BD (AES-256-GCM, `KEY_ENCRYPTION_SECRET`), rotación automática (`SIGNING_KEY_MAX_AGE_DAYS`); las retiradas siguen en el JWKS mientras haya tokens vigentes |
| Refresh token         | Opaco (`<id>.<secreto>`), solo el SHA-256 en BD, rotativo. Reutilizar uno ya rotado revoca toda la sesión (familia); margen de 30 s para pestañas concurrentes                                             |
| Enlaces por correo    | Tokens de un solo uso (verificación 24 h, recuperación 1 h), consumo atómico; restablecer la contraseña cierra todas las sesiones                                                                          |
| Cambios de privilegio | Cambiar roles o deshabilitar revoca las sesiones del usuario; nunca puede quedar la plataforma sin un admin activo                                                                                         |

Eventos (outbox): `UsuarioRegistrado`, `VerificacionEmailSolicitada`, `RecuperacionContrasenaSolicitada`
(los consume `notifications` en la Fase 7; mientras tanto los enlaces se ven en la tabla `outbox`).

## Desarrollo

```bash
npm run infra:up                          # ya incluye identity (2 réplicas) y gateway
# o local con recarga:
cp services/identity/.env.example services/identity/.env
npm run dev -w @services/identity         # http://localhost:3001
```

Administrador inicial (solo desarrollo): `admin@ticketera.local` / `admin-dev-password-123`
(`BOOTSTRAP_ADMIN_*`; solo se crea si no hay ningún admin).

## Pruebas

```bash
TEST_DATABASE_URL=postgres://commons_test:commons_test-dev-password@127.0.0.1:5432/commons_test \
  npm test -w @services/identity
```
