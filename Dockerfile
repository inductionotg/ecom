# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS base

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates dumb-init openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

FROM base AS build

ARG SERVICE_NAME

ENV NODE_ENV=development

RUN case "${SERVICE_NAME}" in \
      order-service|inventory-service|payment-service) ;; \
      *) echo "SERVICE_NAME must be order-service, inventory-service, or payment-service" >&2; exit 1 ;; \
    esac

COPY ${SERVICE_NAME}/package.json ${SERVICE_NAME}/package-lock.json ./

RUN npm ci --no-audit --no-fund

COPY ${SERVICE_NAME}/ ./

# Prisma 6 loads the datasource configuration while generating the client.
# This build-only URL is deliberately fake; real Neon credentials are injected
# only when a migration or application container starts.
RUN DATABASE_URL="postgresql://docker:docker@127.0.0.1:5432/docker" \
    ./node_modules/.bin/prisma generate

FROM build AS migrate

ENV NODE_ENV=production

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "if [ -n \"${MIGRATION_DATABASE_URL:-}\" ]; then export DATABASE_URL=\"$MIGRATION_DATABASE_URL\"; fi; exec ./node_modules/.bin/prisma migrate deploy"]

FROM build AS production-dependencies

RUN npm prune --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && test -s package.json

FROM production-dependencies AS runtime

ENV NODE_ENV=production

# Fail the build if a corrupted layer loses the manifest or generated client.
RUN test -s package.json \
    && node --input-type=module --eval "await import('@prisma/client')"

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/app.js"]
