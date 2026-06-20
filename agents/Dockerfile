# Single-container Railway deploy for the DeFi Swarm backend.
#
# Layout (resilient — skips fragile pre-compile steps):
#   Stage 1 (axl-build) — Go toolchain, clones gensyn-ai/axl. The build
#                         is wrapped in `|| true` so a failing Go build
#                         doesn't kill the whole image; entrypoint
#                         detects a missing /usr/local/bin/axl and sets
#                         AXL_DISABLED automatically.
#   Stage 2 (runtime)   — Node 22 slim image, copies source + node_modules
#                         + AXL binary, runs everything via `tsx` (no
#                         pre-compile, no tsc errors blocking deploy).
#
# What runs at boot:
#   1. (optional) AXL daemon on api:9002 / tls:9101 — auto-skipped if the
#      Go binary didn't build.
#   2. All five agents (api, pm, alm, router, executor) via concurrently.
#
# All five share one AXL daemon (Gensyn's HTTP API hardcodes 9002).
# Cross-host AXL is configured via AXL_BOOTSTRAP_PEERS env at runtime.

# ---------------------------------------------------------------------
# Stage 1: AXL binary (best-effort)
# ---------------------------------------------------------------------
FROM golang:1.22-bookworm AS axl-build

ARG AXL_REPO=https://github.com/gensyn-ai/axl
ARG AXL_REF=main

WORKDIR /src
# Best-effort build. If the repo layout changes or the build invocation
# differs from `go build ./...`, we touch an empty file at /out/axl-missing
# so the runtime stage knows to set AXL_DISABLED. Container still ships.
RUN set -eux; \
    git clone --depth 1 --branch ${AXL_REF} ${AXL_REPO} . || (mkdir -p /out && touch /out/axl-missing && exit 0); \
    if [ -d cmd/axl ]; then \
      CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/axl ./cmd/axl || (mkdir -p /out && touch /out/axl-missing); \
    else \
      CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/axl ./... || (mkdir -p /out && touch /out/axl-missing); \
    fi; \
    [ -f /out/axl ] || touch /out/axl-missing

# ---------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Runtime deps: openssl (Prisma), ca-certificates (HTTPS), tini for
# clean signal handling, jq + curl for the entrypoint.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini jq curl git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy npm workspace manifests and install. Using `npm install`
# (not `ci`) so a missing-or-stale lockfile doesn't fail the build.
# `--ignore-scripts` skips the postinstall prisma:generate hook —
# we run it manually after copying the schema.
COPY agents/package.json agents/package-lock.json* ./
COPY agents/shared/package.json ./shared/
COPY agents/api/package.json ./api/
COPY agents/pm/package.json ./pm/
COPY agents/alm/package.json ./alm/
COPY agents/router/package.json ./router/
COPY agents/executor/package.json ./executor/

# Slim install:
#   --legacy-peer-deps : tolerate the wagmi/viem/walletconnect peer
#                        graph mismatches that npm 10 strict-resolves
#   --maxsockets=2     : reduce parallelism — Railway's build OOMs on
#                        the default 50 with 700+ packages
#   --no-audit --no-fund: smaller logs
#   --ignore-scripts   : skip postinstall (we run prisma:generate
#                        explicitly after copying the schema)
RUN npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund \
      --maxsockets=2 --prefer-offline

# Now copy the rest of the agents source.
COPY agents/ ./

# Generate the typed Prisma client. This is the only mandatory build
# step — without it `db().swarmSettings` etc. is undefined at runtime.
RUN npm --workspace shared run prisma:generate

# AXL binary (best-effort copy — entrypoint handles the missing case).
COPY --from=axl-build /out/ /tmp/axl-out/
RUN if [ -f /tmp/axl-out/axl ]; then \
      cp /tmp/axl-out/axl /usr/local/bin/axl && chmod +x /usr/local/bin/axl; \
      echo "[image] AXL binary installed"; \
    else \
      echo "[image] AXL binary missing — runtime will set AXL_DISABLED=true"; \
    fi

# Entrypoint
COPY agents/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 9002 9101
ENV API_PORT=8787

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
