#!/usr/bin/env bash
# Boot a single AXL daemon for the local swarm.
#
# Per Gensyn's current AXL build, the HTTP API port is hardcoded to 9002
# and can't be remapped per node. Running 4 daemons on one host is
# therefore not viable — they collide on 9002. Production deploys put
# each agent on its own host (own daemon, own 9002). For local dev, a
# single daemon serves all four agents fine: same publish/subscribe
# surface, just no inter-agent peer hops to demonstrate.
#
# Configure the daemon's TCP/TLS bootstrap peers via AXL_BOOTSTRAP_PEERS
# (comma-sep "tls://host:port") if you want to peer with a remote AXL
# network. Empty = isolated single-node mesh, fine for the demo.

set -eu
cd "$(dirname "$0")"

AXL_BIN="${AXL_BIN:-$HOME/shiva/axl/node}"
if [ ! -x "$AXL_BIN" ]; then
  echo "AXL binary not found at $AXL_BIN" >&2
  exit 1
fi

mkdir -p logs nodes/shared
node_dir="./nodes/shared"

# Reuse pm's keypair as the shared node's identity (we already generated
# it, no point making a new one).
[ -f "$node_dir/private.pem" ] || cp ./nodes/pm/private.pem "$node_dir/private.pem"

# Build the Peers array from $AXL_BOOTSTRAP_PEERS env (comma-sep).
# In single-daemon mode we ALSO add a self-peer entry — the daemon then
# loops messages from /send back into its own /recv inbox, giving us a
# real publish-subscribe path over AXL even with one daemon. Without
# this, topology() returns [] and publish() is a no-op.
peers_json='"tls://127.0.0.1:9101"'
if [ -n "${AXL_BOOTSTRAP_PEERS:-}" ]; then
  remote=$(echo "$AXL_BOOTSTRAP_PEERS" | awk -F, '{
    for (i=1;i<=NF;i++) printf("%s\"%s\"", (i>1?",":""), $i);
  }')
  peers_json="$peers_json,$remote"
fi

cfg="$node_dir/node-config.json"
cat > "$cfg" <<JSON
{
  "PrivateKeyPath": "$(pwd)/$node_dir/private.pem",
  "Peers": [${peers_json}],
  "Listen": ["tls://127.0.0.1:9101"]
}
JSON

log="logs/axl.log"
echo "starting axl  api:9002  tls:9101  -> $log"
nohup "$AXL_BIN" -config "$cfg" >"$log" 2>&1 &

sleep 2
echo
echo "AXL daemon up. All 4 agents share this one daemon."
echo "Verify:  curl http://127.0.0.1:9002/topology | jq"
echo "Tail log: tail -f $log"
echo "Stop:    pkill -f $AXL_BIN"
