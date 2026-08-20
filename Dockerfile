# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ARG CODEX_VERSION=0.148.0

LABEL org.opencontainers.image.title="Slab Runner" \
      org.opencontainers.image.description="Runtime daemon for Slab agents" \
      org.opencontainers.image.version="development" \
      org.opencontainers.image.source="https://github.com/martin2844/slab-runner"

RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && groupadd --system --gid 10001 slab-runner \
  && useradd --system --uid 10001 --gid slab-runner --create-home slab-runner

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/slab-runner/codex /tmp/slab-runner-workspace \
  && chown -R slab-runner:slab-runner /var/lib/slab-runner /tmp/slab-runner-workspace

ENV NODE_ENV=production \
    RUNNER_HOST=127.0.0.1 \
    RUNNER_PORT=6990 \
    RUNNER_CODEX_HOME=/var/lib/slab-runner/codex \
    CODEX_BIN=/usr/local/bin/codex

USER slab-runner

VOLUME ["/var/lib/slab-runner/codex"]
EXPOSE 6990

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:6990/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/cli.js", "start"]

