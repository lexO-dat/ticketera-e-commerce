# Imagen de producción del servicio. Contexto de build: raíz del repo (necesita los workspaces).
#   docker build -f services/catalog/Dockerfile -t ticketera/catalog .
ARG NODE_IMAGE=node:22-alpine
ARG SERVICE=catalog

FROM ${NODE_IMAGE} AS build
ARG SERVICE
WORKDIR /repo
COPY . .
RUN npm ci --workspace "@services/${SERVICE}" --include-workspace-root=false --ignore-scripts --no-audit --no-fund \
  && npm run build --workspace "@services/${SERVICE}"

FROM ${NODE_IMAGE} AS prod-deps
ARG SERVICE
WORKDIR /repo
COPY . .
RUN npm ci --workspace "@services/${SERVICE}" --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production PORT=3000
# Mismo layout que el monorepo: algunas dependencias quedan anidadas en el workspace
# (p. ej. zod 4 del backend convive con zod 3 de apps/web).
COPY --from=prod-deps --chown=node:node /repo/node_modules /app/node_modules
COPY --from=prod-deps --chown=node:node /repo/services/${SERVICE} /app/services/${SERVICE}
COPY --from=build --chown=node:node /repo/services/${SERVICE}/dist /app/services/${SERVICE}/dist
WORKDIR /app/services/${SERVICE}
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
