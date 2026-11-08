# Contexto de build: raíz del repo (incluye apps/scanner).
#   docker build -f infra/nginx/Dockerfile .

# App de validación en puerta (estática, se sirve en /scanner/).
FROM node:22-alpine AS scanner
WORKDIR /repo
COPY . .
RUN npm ci --workspace @apps/scanner --include-workspace-root=false --ignore-scripts --no-audit --no-fund   && npm run build --workspace @apps/scanner

FROM nginx:1.29-alpine

# openssl solo para generar el certificado autofirmado de desarrollo al arrancar.
RUN apk add --no-cache openssl

COPY infra/nginx/10-dev-certificate.sh /docker-entrypoint.d/10-dev-certificate.sh
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
RUN rm -f /etc/nginx/conf.d/default.conf
COPY infra/nginx/conf.d/ /etc/nginx/conf.d/
COPY --from=scanner /repo/apps/scanner/dist /usr/share/nginx/scanner

RUN chmod +x /docker-entrypoint.d/10-dev-certificate.sh
