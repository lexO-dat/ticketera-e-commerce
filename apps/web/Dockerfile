# Web del comprador y panel admin (TanStack Start con SSR, salida de Nitro para Node).
# Contexto de build: raíz del repo (necesita los workspaces).
#   docker build -f apps/web/Dockerfile -t ticketera/web .
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
COPY . .
RUN npm ci --workspace @apps/web --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
  && NITRO_PRESET=node-server npm run build --workspace @apps/web

# Nitro deja en .output un servidor autocontenido (código y dependencias trazadas): no hace falta
# node_modules del monorepo en la imagen final.
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.output ./.output
USER node
EXPOSE 3000
# robots.txt es un archivo estático: comprueba que el servidor responde sin llamar al gateway.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/robots.txt" >/dev/null || exit 1
CMD ["node", ".output/server/index.mjs"]
