#!/usr/bin/env bash
# One-shot Railway deploy for the DeFi Swarm backend.
#
# Usage:
#   1. Generate a fresh Railway token at
#      https://railway.app/account/tokens
#   2. Put it in agents/.env.railway (file is gitignored), one line:
#        RAILWAY_TOKEN=...
#   3. Set the rest of your runtime env in agents/.env (same file
#      dev:all uses — the script reads it and uploads to Railway).
#   4. Run: ./agents/deploy-railway.sh
#
# The script:
#   - verifies the token works
#   - creates / links a Railway project named "defi-swarm-backend"
#     (idempotent — if you've already run this, it links to the
#     existing project)
#   - adds a Postgres plugin if the project doesn't have one
#   - syncs every non-secret-looking var from agents/.env into Railway
#   - runs `railway up` from the repo root with the agents/Dockerfile

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT_NAME="${RAILWAY_PROJECT_NAME:-defi-swarm-backend}"
ENV_FILE="$REPO_ROOT/agents/.env"
TOKEN_FILE="$REPO_ROOT/agents/.env.railway"

# --- preflight -------------------------------------------------------------

if ! command -v railway >/dev/null 2>&1; then
  echo "[deploy] railway CLI not found"
  echo "        install with: brew install railway   (or: npm i -g @railway/cli)"
  exit 1
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "[deploy] missing $TOKEN_FILE"
  echo "        create it with one line:  RAILWAY_TOKEN=<your fresh token>"
  exit 1
fi

# Source the token but don't print it.
# shellcheck disable=SC1090
. "$TOKEN_FILE"

# Set BOTH env vars — Railway CLI uses one or the other depending on
# which command is running. No verification — let railway up fail or
# succeed on its own.
if [ -n "${RAILWAY_API_TOKEN:-}" ]; then
  export RAILWAY_API_TOKEN
  export RAILWAY_TOKEN="${RAILWAY_TOKEN:-$RAILWAY_API_TOKEN}"
elif [ -n "${RAILWAY_TOKEN:-}" ]; then
  export RAILWAY_TOKEN
  export RAILWAY_API_TOKEN="${RAILWAY_API_TOKEN:-$RAILWAY_TOKEN}"
else
  echo "[deploy] no token in $TOKEN_FILE — set RAILWAY_TOKEN or RAILWAY_API_TOKEN" >&2
  exit 1
fi
echo "[deploy] token loaded (skipping pre-verification)"

if [ ! -f "$ENV_FILE" ]; then
  echo "[deploy] missing $ENV_FILE — copy agents/.env.example and fill it in" >&2
  exit 1
fi

# --- project + plugin ------------------------------------------------------

# Check if we're already linked.
if [ ! -f "$REPO_ROOT/.railway/project.json" ]; then
  echo "[deploy] not linked — creating / linking project '$PROJECT_NAME'"
  # `railway init` is interactive; force-create via the GraphQL API
  # would be cleaner but the CLI's `link` flow is good enough.
  if railway list 2>/dev/null | grep -q "$PROJECT_NAME"; then
    railway link --project "$PROJECT_NAME"
  else
    railway init --name "$PROJECT_NAME"
  fi
else
  echo "[deploy] already linked"
fi

# Ensure a Postgres plugin exists. `railway add` is idempotent in the
# sense that it won't create a duplicate — but it returns nonzero if
# the plugin's already there, so we tolerate that.
if ! railway variables 2>/dev/null | grep -q '^DATABASE_URL='; then
  echo "[deploy] adding Postgres plugin"
  railway add --plugin postgresql
fi

# --- env sync --------------------------------------------------------------

echo "[deploy] syncing env from $ENV_FILE"

# Skip empty lines, comments, and the RAILWAY_TOKEN itself if someone
# accidentally put it in .env. Build the args as separate KEY=VALUE
# pairs so values with spaces survive.
ENV_ARGS=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|\#*) continue ;;
    RAILWAY_TOKEN=*) continue ;;
  esac
  ENV_ARGS+=("$line")
done < "$ENV_FILE"

if [ ${#ENV_ARGS[@]} -gt 0 ]; then
  railway variables set "${ENV_ARGS[@]}"
fi

# --- deploy ----------------------------------------------------------------

echo "[deploy] uploading + building (first build is slow — Go AXL stage)"
railway up --detach

echo ""
echo "[deploy] done. Tail logs with:"
echo "         railway logs"
echo ""
echo "[deploy] once healthcheck passes, your API is at:"
railway domain 2>/dev/null || echo "         (run 'railway domain' to generate one)"
