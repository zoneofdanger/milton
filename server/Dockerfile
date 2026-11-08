FROM oven/bun:1.4.4 AS build
WORKDIR /repo
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY packages/theme/package.json packages/theme/package.json
COPY packages/forwarded-client/package.json packages/forwarded-client/package.json
COPY apps/site/package.json apps/site/package.json
COPY apps/auth/package.json apps/auth/package.json
RUN bun install --frozen-lockfile --filter @milton/server
COPY server/src server/src
COPY server/scripts/build.ts server/scripts/build.ts
COPY server/scripts/e2e.ts server/scripts/e2e.ts
COPY server/scripts/e2e-http.ts server/scripts/e2e-http.ts
COPY apps/auth/src/recipient.ts apps/auth/src/recipient.ts
COPY server/vite.config.ts server/vite.config.ts
COPY server/tsconfig.json server/tsconfig.json
COPY packages/theme packages/theme
COPY packages/forwarded-client packages/forwarded-client
RUN bun run --cwd server build

FROM node:26-bookworm-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY server/package.json ./server/package.json
COPY --from=build /repo/server/dist/cloud-run.js ./server/dist/cloud-run.js
COPY --from=build /repo/server/dist/guide-worker.js ./server/dist/guide-worker.js
COPY --from=build /repo/server/dist/e2e.js ./server/dist/e2e.js
COPY --from=build /repo/server/public ./server/public
USER node
EXPOSE 8080
CMD ["node", "server/dist/cloud-run.js"]
