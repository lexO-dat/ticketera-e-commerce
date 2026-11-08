# scanner — app de validación en puerta

App web (React + Vite) para el personal del evento (RF15). Se publica en
**https://localhost:8443/scanner/** (Nginx, mismo origen que `/api`).

- Inicia sesión con una cuenta de rol `staff`, `organizer` o `admin` (identity). Los tokens viven
  solo en memoria de la pestaña; se renuevan solos con el refresh token.
- Elige evento, función y puerta; escanea con la cámara trasera (`BarcodeDetector` nativo o
  [jsQR](https://github.com/cozmo/jsQR) como respaldo) o escribe el código impreso.
- Muestra el resultado a pantalla completa (verde: adelante; rojo: ya usada, anulada o QR no válido;
  ámbar: otra función), vibra y lleva el conteo de ingresados.
- La validez la decide siempre el servicio `tickets` con un marcado atómico: la app no guarda estado.

Crear una cuenta de puerta (con un token de admin): `POST /api/admin/users` con `roles: ["staff"]`
(el panel "Equipo" por ahora solo crea administradores).

```bash
npm run dev:scanner        # http://localhost:5174/scanner/ (proxy /api → gateway)
npm run build -w @apps/scanner
```
