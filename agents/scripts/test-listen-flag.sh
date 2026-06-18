#!/usr/bin/env bash
# Probe what AXL's `-listen` CLI flag actually overrides.
# Hypothesis: it changes the HTTP API bind address. If so, we can run
# multiple daemons natively on macOS via lo0 aliases.

set -eu
AXL_BIN="${AXL_BIN:-$HOME/shiva/axl/node}"
PROBE_DIR="$(mktemp -d -t axl-listen.XXXXXX)"
trap 'rm -rf "$PROBE_DIR"; pkill -f "$PROBE_DIR" 2>/dev/null || true' EXIT

cat > "$PROBE_DIR/cfg.json" <<JSON
{
  "PrivateKeyPath": "$PROBE_DIR/key.pem",
  "Peers": [],
  "Listen": ["tls://127.0.0.1:19101"]
}
JSON
openssl genpkey -algorithm ed25519 -out "$PROBE_DIR/key.pem" 2>/dev/null

cd "$PROBE_DIR"

echo "=== Test 1: -listen 127.0.0.1:19002 (custom HTTP-ish addr) ==="
"$AXL_BIN" -listen "127.0.0.1:19002" -config cfg.json > log1 2>&1 &
PID=$!
sleep 1.5
echo "--- log ---"
sed -n '1,15p' log1
echo "--- ports bound by daemon ---"
lsof -p $PID -P -nL 2>/dev/null | grep -E 'TCP.*LISTEN' || echo "(no LISTEN sockets visible)"
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
echo

echo "=== strings in binary: 127.0.0.1 + bind address candidates ==="
strings "$AXL_BIN" | grep -E '^127\.0\.0\.1$|0\.0\.0\.0|localhost:|http://127' | sort -u | head -20
echo

echo "=== strings: known config field names ==="
strings "$AXL_BIN" | grep -E '^(ApiAddr|ApiHost|HttpListen|HttpAddr|ListenAddr|ListenHTTP|HttpListenAddr|RpcAddr|RpcPort|ApiBind)$' | sort -u
