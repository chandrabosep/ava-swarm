#!/usr/bin/env bash
# Push agents/.env into the currently-linked Railway service, then redeploy.
#
# Pre-reqs:
#   1. `railway login` already done.
#   2. `railway service` linked to the **agents** service (NOT Postgres).
#      Run: railway status   # confirm Service: agents
#   3. agents/.env contains the runtime env (Supabase URLs, AXL endpoints, etc.)
#
# What it does:
#   - Reads every KEY=VALUE line in agents/.env
#   - Skips comments, blank lines, and RAILWAY_TOKEN/RAILWAY_API_TOKEN
#   - Strips wrapping double quotes from values (Railway stores them literally
#     otherwise, which breaks Supabase URLs)
#   - Calls `railway variables --set KEY=VALUE …` once with all pairs
#   - Triggers `railway up --detach`

set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/agents/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[sync] missing $ENV_FILE" >&2
  exit 1
fi

# Refuse if we're linked to Postgres — would clobber the DB.
LINKED="$(railway status 2>/dev/null | awk -F': ' '/^Service:/ {print $2}')"
echo "[sync] linked service: ${LINKED:-<none>}"
if [ -z "$LINKED" ]; then
  echo "[sync] no service linked. Run: railway service   (and pick agents)" >&2
  exit 1
fi
if [ "$LINKED" = "Postgres" ]; then
  echo "[sync] refusing to push agents env to the Postgres service." >&2
  echo "       Run: railway service   # and pick the agents service" >&2
  exit 1
fi

# Build the --set arg list. Skip RAILWAY_TOKEN, comments, blank lines.
# Strip surrounding double quotes from values.
SET_ARGS=()
COUNT=0
while IFS= read -r line || [ -n "$line" ]; do
  # Strip CR if file has CRLF endings
  line="${line%$'\r'}"
  case "$line" in
    ''|\#*) continue ;;
    RAILWAY_TOKEN=*|RAILWAY_API_TOKEN=*) continue ;;
  esac
  # Must contain an =
  case "$line" in
    *=*) ;;
    *) continue ;;
  esac

  KEY="${line%%=*}"
  VAL="${line#*=}"

  # Trim wrapping double quotes if present on both ends.
  case "$VAL" in
    \"*\")
      VAL="${VAL#\"}"
      VAL="${VAL%\"}"
      ;;
  esac

  SET_ARGS+=(--set "${KEY}=${VAL}")
  COUNT=$((COUNT + 1))
done < "$ENV_FILE"

if [ "$COUNT" -eq 0 ]; then
  echo "[sync] no variables found in $ENV_FILE" >&2
  exit 1
fi

echo "[sync] applying $COUNT variables to '$LINKED'…"
railway variables "${SET_ARGS[@]}"

echo "[sync] redeploying…"
railway up --detach

echo ""
echo "[sync] done. Tail logs with:"
echo "         railway logs --deployment"
