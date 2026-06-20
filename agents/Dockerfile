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
# Stage 1: AXL binary
# ---------------------------------------------------------------------
# The gensyn-ai/axl repo's actual entrypoint is cmd/node (built locally
# via `make build` → `go build -o node ./cmd/node`). The repo's go.mod
# pins GOTOOLCHAIN=go1.25.5, so we use golang:1.25 — the toolchain
# directive will reject 1.22.
#
# Output binary is named `axl` (not `node`) so the runtime entrypoint can
# invoke it as `axl -config ...` matching the existing scripts.
#
# This stage is no longer wrapped in `|| true` — if the build fails, the
# image build fails loudly. Comment out the COPY in the runtime stage and
# the container still boots (entrypoint detects missing binary and sets
# AXL_DISABLED), but we want this stage to actually succeed in production.
FROM golang:1.25-bookworm AS axl-build

ARG AXL_REPO=https://github.com/gensyn-ai/axl
ARG AXL_REF=main

WORKDIR /src
RUN set -eux; \
    git clone --depth 1 --branch ${AXL_REF} ${AXL_REPO} .; \
    mkdir -p /out; \
    if [ -d cmd/node ]; then \
      echo "[axl-build] building from cmd/node (repo layout matches local Makefile)"; \
      CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/axl ./cmd/node; \
    elif [ -d cmd/axl ]; then \
      echo "[axl-build] building from cmd/axl"; \
      CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /out/axl ./cmd/axl; \
    else \
      echo "[axl-build] no recognized cmd/* layout — running 'make build' if Makefile exists"; \
      if [ -f Makefile ]; then \
        make build; \
        # Local Makefile produces ./node — copy it as /out/axl
        if [ -f node ]; then mv node /out/axl; \
        elif [ -f axl ]; then mv axl /out/axl; \
        else echo "[axl-build] make build did not produce expected binary" >&2; exit 1; fi; \
      else \
        echo "[axl-build] no Makefile and no cmd/{node,axl} — failing build" >&2; exit 1; \
      fi; \
    fi; \
    test -x /out/axl; \
    /out/axl --help 2>&1 | head -20 || true

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
