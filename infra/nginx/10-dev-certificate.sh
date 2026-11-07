#!/bin/sh
# Genera un certificado autofirmado para https://localhost si no existe uno montado.
# Solo desarrollo: en producción el certificado viene del secret store.
set -eu

CERT_DIR=/etc/nginx/certs
if [ -s "$CERT_DIR/tls.crt" ] && [ -s "$CERT_DIR/tls.key" ]; then
  exit 0
fi

mkdir -p "$CERT_DIR"
openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$CERT_DIR/tls.key" -out "$CERT_DIR/tls.crt" -days 825 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
chmod 600 "$CERT_DIR/tls.key"
echo "nginx: certificado autofirmado de desarrollo generado"
