# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Code profile: a full toolchain image where Codex works on git checkouts.
# Build with `docker build --target code .`. The container is the sandbox.
# This stage sits before `runtime` so a plain `docker build .` still produces
# the default runtime image.
FROM node:22-trixie AS code

ARG CODEX_VERSION=0.148.0

LABEL org.opencontainers.image.title="Slab Runner (code)" \
      org.opencontainers.image.description="Runtime daemon for Slab coding runs" \
      org.opencontainers.image.version="development" \
      org.opencontainers.image.source="https://github.com/martin2844/slab-runner"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    jq \
    procps \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    unzip \
    zip \
    # Media and headless desktop tests: FFmpeg, a virtual display, audio, and the
    # shared libraries Electron needs. Release builds and signing stay off this host.
    ffmpeg \
    pulseaudio \
    pulseaudio-utils \
    xauth \
    xvfb \
    fonts-liberation \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libcups2t64 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0t64 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    libxss1 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && corepack enable \
  && groupadd --system --gid 10001 slab-runner \
  && useradd --system --uid 10001 --gid slab-runner --create-home slab-runner

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/slab-runner/codex /var/lib/slab-code /tmp/slab-runner-workspace \
  && chown -R slab-runner:slab-runner /var/lib/slab-runner /var/lib/slab-code /tmp/slab-runner-workspace

# Package-manager caches live on the code volume next to the checkouts.
ENV NODE_ENV=production \
    RUNNER_HOST=127.0.0.1 \
    RUNNER_PORT=6990 \
    RUNNER_PROFILE=code \
    RUNNER_CODE_ROOT=/var/lib/slab-code \
    RUNNER_CODEX_HOME=/var/lib/slab-runner/codex \
    CODEX_BIN=/usr/local/bin/codex \
    # NODE_ENV=production is for the runner itself; checkouts still need devDependencies
    # (test runners, Electron) when an agent runs npm ci.
    npm_config_include=dev \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/var/lib/slab-code/cache/corepack \
    npm_config_cache=/var/lib/slab-code/cache/npm \
    XDG_CACHE_HOME=/var/lib/slab-code/cache \
    XDG_DATA_HOME=/var/lib/slab-code/data

USER slab-runner

VOLUME ["/var/lib/slab-runner/codex", "/var/lib/slab-code"]
EXPOSE 6990

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:6990/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/cli.js", "start"]

FROM node:22-bookworm-slim AS runtime

ARG CODEX_VERSION=0.148.0
ARG GEMINI_CLI_VERSION=0.56.0

LABEL org.opencontainers.image.title="Slab Runner" \
      org.opencontainers.image.description="Runtime daemon for Slab agents" \
      org.opencontainers.image.version="development" \
      org.opencontainers.image.source="https://github.com/martin2844/slab-runner"

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "@openai/codex@${CODEX_VERSION}" "@google/gemini-cli@${GEMINI_CLI_VERSION}" \
  && npm cache clean --force \
  && rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /opt/yarn-v1.22.22 \
  && groupadd --system --gid 10001 slab-runner \
  && useradd --system --uid 10001 --gid slab-runner --create-home slab-runner

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/slab-runner/codex /var/lib/slab-runner/gemini /tmp/slab-runner-workspace \
  && chown -R slab-runner:slab-runner /var/lib/slab-runner /tmp/slab-runner-workspace

ENV NODE_ENV=production \
    RUNNER_HOST=127.0.0.1 \
    RUNNER_PORT=6990 \
    RUNNER_CODEX_HOME=/var/lib/slab-runner/codex \
    CODEX_BIN=/usr/local/bin/codex \
    RUNNER_GEMINI_HOME=/var/lib/slab-runner/gemini \
    GEMINI_BIN=/usr/local/bin/gemini

USER slab-runner

VOLUME ["/var/lib/slab-runner/codex", "/var/lib/slab-runner/gemini"]
EXPOSE 6990

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:6990/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/cli.js", "start"]
