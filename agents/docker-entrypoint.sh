#!/usr/bin/env bash
# Boots the AXL daemon (single-host loopback mesh by default), then
# launches all five agents via the existing `npm start` script which
# fans out via concurrently.
#
# Behaviour controls (set via Railway env):
#   PORT              — Railway-injected; routed to API_PORT for Express.
#   AXL_DISABLED=true — skip the AXL daemon entirely; agents fall back to
#                       PG NOTIFY transport. Use when you can't / don't
#                       want to expose 9101.
#   AXL_BOOTSTRAP_PEERS — comma-sep "tls://host:port" for cross-host
#                         mesh. Empty = single-host loopback.

set -eu

# Railway ships PORT but Express reads API_PORT. In production we always
# defer to Railway's injected PORT — overriding any value baked into the
# image's env or copied in from agents/.env. Otherwise the public-facing
# healthcheck can't reach the API.
if [ -n "${PORT:-}" ]; then
  export API_PORT="$PORT"
fi

# Run database migrations on boot. Idempotent — Prisma skips
# already-applied ones. Failures here should kill the container so we
# don't run agents against a stale schema.
#
# We bypass the `prisma:migrate` npm script because it's wrapped with
# `dotenv -e ../.env --` for local dev, which tries to read agents/.env
# (not present in the Railway image) and clobbers DATABASE_URL → P1013.
# In the container, env vars come from Railway directly. We also call
# `migrate deploy` (not `migrate dev`) — production-safe, non-interactive.
echo "[entrypoint] applying prisma migrations…"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] DATABASE_URL is not set — refusing to start agents" >&2
  exit 1
fi
(cd /app/shared && npx --no-install prisma migrate deploy) || {
  echo "[entrypoint] prisma migrate failed — refusing to start agents" >&2
  exit 1
}

# AXL daemon — auto-skipped if the binary didn't build (image stage 1
# couldn't compile the Gensyn AXL Go code). Manually skip with
# AXL_DISABLED=true if you want to force the PG-only fallback.
if [ ! -x /usr/local/bin/axl ]; then
  echo "[entrypoint] AXL binary not present in image — falling back to PG transport"
  AXL_DISABLED=true
fi

if [ "${AXL_DISABLED:-false}" = "true" ]; then
  echo "[entrypoint] AXL_DISABLED=true — skipping daemon, agents use PG transport"
else
  AXL_DATA="/tmp/axl"
  mkdir -p "$AXL_DATA"

  KEY_PATH="$AXL_DATA/private.pem"
  if [ ! -f "$KEY_PATH" ]; then
    # Generate a fresh keypair on first boot. Volume-less Railway
    # containers regenerate on every restart, which means peer-IDs
    # change — fine for single-host, you'd want a Railway volume
    # mount on /tmp/axl for stable cross-host identity.
    if axl generate-key --out "$KEY_PATH" 2>/dev/null; then
      echo "[entrypoint] generated AXL keypair at $KEY_PATH"
    elif axl genkey --out "$KEY_PATH" 2>/dev/null; then
      echo "[entrypoint] generated AXL keypair at $KEY_PATH (genkey)"
    else
      # Fallback: openssl ed25519 keypair. AXL uses ed25519 keys per
      # the agents/axl-node/nodes/*/private.pem files in the repo.
      openssl genpkey -algorithm ED25519 -out "$KEY_PATH"
      echo "[entrypoint] generated ed25519 keypair via openssl at $KEY_PATH"
    fi
  fi

  # Build the peer list. Always include the self-loopback peer so the
  # daemon delivers our own messages back to /recv (matches the dev
  # behavior in agents/axl-node/start-axl.sh). Append remote peers if
  # configured.
  PEERS_JSON='"tls://127.0.0.1:9101"'
  if [ -n "${AXL_BOOTSTRAP_PEERS:-}" ]; then
    REMOTE=$(echo "$AXL_BOOTSTRAP_PEERS" | awk -F, '{
      for (i=1;i<=NF;i++) printf("%s\"%s\"", (i>1?",":""), $i);
    }')
    PEERS_JSON="$PEERS_JSON,$REMOTE"
  fi

  cat > "$AXL_DATA/node-config.json" <<JSON
{
  "PrivateKeyPath": "$KEY_PATH",
  "Peers": [${PEERS_JSON}],
  "Listen": ["tls://0.0.0.0:9101"]
}
JSON

  echo "[entrypoint] starting AXL daemon (api:9002 tls:9101)"
  axl -config "$AXL_DATA/node-config.json" > /tmp/axl.log 2>&1 &
  AXL_PID=$!

  # Wait up to 10s for the API to come up before launching agents,
  # otherwise their first /topology call races the daemon.
  for i in $(seq 1 20); do
    if curl -sf http://127.0.0.1:9002/topology > /dev/null 2>&1; then
      echo "[entrypoint] AXL up (PID $AXL_PID)"
      break
    fi
    sleep 0.5
  done

  if ! curl -sf http://127.0.0.1:9002/topology > /dev/null 2>&1; then
    echo "[entrypoint] AXL did not come up in 10s — agents will fall back to PG transport" >&2
    tail -20 /tmp/axl.log >&2 || true
  fi
fi

# Hand off to the agents. `exec` so signals (SIGTERM from Railway on
# redeploy) propagate cleanly via tini's PID 1 supervisor.
echo "[entrypoint] launching agents (api + pm + alm + router + executor)"
exec npm start
