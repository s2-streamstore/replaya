# syntax=docker/dockerfile:1

FROM node:24-slim AS pnpm-base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.1 --activate

# ---- build ----
FROM pnpm-base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---- runtime ----
FROM pnpm-base AS runtime
ENV NODE_ENV=production

# Production deps only. rrweb stays (it's a runtime dependency: the server
# serves /vendor/rrweb.min.js from node_modules).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune

# Compiled server + built client assets.
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist

ENV PORT=8787
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
