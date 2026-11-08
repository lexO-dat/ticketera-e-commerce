# Monitor de failover de PostgreSQL (ADR-01). Build: docker build infra/pg-failover
FROM node:22-alpine
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund pg@8.23.1 \
  && npm cache clean --force \
  && mkdir /state && chown node /state
COPY monitor.mjs ./
USER node
CMD ["node", "monitor.mjs"]
