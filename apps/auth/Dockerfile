# Build from repository root. Release must select/pin both base images by digest.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/site/package.json apps/site/package.json
COPY packages/theme packages/theme
COPY packages/forwarded-client packages/forwarded-client
COPY server/package.json server/package.json
COPY apps/auth apps/auth
RUN bun --no-env-file install --frozen-lockfile && bun --no-env-file run --cwd apps/auth build
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /src/apps/auth/dist ./
USER node
EXPOSE 8080
CMD ["node", "cloud-run.js"]
