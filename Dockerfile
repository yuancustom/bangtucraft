FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN corepack pnpm install --frozen-lockfile --filter @drawing-agent/web...
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/shared packages/shared
RUN corepack pnpm -C apps/web build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
ENV BACKEND_URL=http://host.docker.internal:8787
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
