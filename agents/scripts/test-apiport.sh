#!/usr/bin/env bash
# Confirm AXL config supports "ApiPort" by booting a one-off daemon on
# a non-default HTTP port and checking /topology answers there.

set -eu
AXL_BIN="${AXL_BIN:-$HOME/shiva/axl/node}"
PROBE_DIR="$(mktemp -d -t axl-probe.XXXXXX)"
trap 'rm -rf "$PROBE_DIR"; pkill -f "$PROBE_DIR" 2>/dev/null || true' EXIT

# minimal config with ApiPort set to a free port
cat > "$PROBE_DIR/cfg.json" <<JSON
{
  "PrivateKeyPath": "$PROBE_DIR/key.pem",
  "Peers": [],
  "Listen": ["tls://127.0.0.1:19101"],
  "ApiPort": 19002
}
JSON

# generate a fresh key (ed25519) — AXL parses ed25519 PEM
openssl genpkey -algorithm ed25519 -out "$PROBE_DIR/key.pem" 2>/dev/null

cd "$PROBE_DIR"
"$AXL_BIN" -config cfg.json > "$PROBE_DIR/log" 2>&1 &
AXL_PID=$!
sleep 1.5

echo "--- daemon log ---"
head -20 "$PROBE_DIR/log"
echo
echo "--- probing http://127.0.0.1:19002/topology ---"
curl -s -m 2 http://127.0.0.1:19002/topology && echo "  → ApiPort works" || echo "  → no response on 19002"
echo
echo "--- probing http://127.0.0.1:9002/topology (default) ---"
curl -s -m 2 http://127.0.0.1:9002/topology >/dev/null && echo "  → 9002 still bound (ApiPort ignored)" || echo "  → 9002 NOT bound (ApiPort respected)"

kill $AXL_PID 2>/dev/null || true
wait $AXL_PID 2>/dev/null || true
