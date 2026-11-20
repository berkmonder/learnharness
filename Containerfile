# LearnHarness as a web app on a server (berkmonder's fork): the same standalone Next.js server the desktop
# app runs, without Electron. One instance; its data and keys live in /data (a volume).
#   podman build -t learnharness .
#   podman run -p 127.0.0.1:3000:3000 -v learnharness-data:/data learnharness
# It has no login of its own: put it behind something that decides who reaches it (on berkmonder's PC,
# Tailscale: nix-dotfiles hosts/desktop/learnharness.nix).

FROM docker.io/library/node:26-trixie-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# As the desktop release builds it (.github/workflows/ci.yml), and the same smoke checks: the server starts
# and answers with an empty data folder.
RUN npm run build \
 && node scripts/smoke-provider-runtime.mjs \
 && node scripts/build-server.mjs \
 && node scripts/smoke-server.mjs

FROM docker.io/library/node:26-trixie-slim
# Chromium: the visual explanations and demos are rendered with it (puppeteer-core, CHROME_PATH).
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
RUN install -d -o node -g node /data
USER node
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 PORT=3000 \
    LH_DATA_DIR=/data LH_AUTH_FILE=/data/auth.json \
    CHROME_PATH=/usr/bin/chromium
VOLUME /data
EXPOSE 3000
# Health check: the runner's (Podman's OCI images carry none); on the PC, HealthCmd in its unit.
CMD ["node", "server.js"]
