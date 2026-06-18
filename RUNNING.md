# Running the Swarm

## Prerequisites

- Node 20+
- A funded MetaMask EOA on Ethereum mainnet (for delegation + KH wallet funding)
- The AXL binary at `~/shiva/axl/node` (Mach-O ARM64 build)
- A Supabase Postgres project — `DATABASE_URL` (port 6543, pgbouncer) and `DIRECT_URL` (port 5432) in `agents/.env`
- A Groq API key in `agents/.env` (`GROQ_API_KEY=gsk_...`)
- A KeeperHub MCP integration ID in `agents/.env` (`KEEPERHUB_INTEGRATION_ID=...`)
- A Zerion API key in `.env` (frontend) and the Zerion proxy URL in `agents/.env`

## One-time setup

```bash
cd defi-swarm-newtab
npm install                  # frontend
cd agents && npm install     # backend workspace
npm --workspace shared run prisma:generate
```

## Start everything

Three terminals.

**Terminal 1 — AXL daemon (single shared instance)**

```bash
cd ~/shiva/open-agents/defi-swarm-newtab/agents/axl-node
./start-axl.sh
```

Logs at `axl-node/logs/axl.log`. Kill with `pkill -f "shiva/axl/node"`.

**Terminal 2 — Agent processes (PM, ALM, Router, Executor, API)**

```bash
cd ~/shiva/open-agents/defi-swarm-newtab/agents
npm run dev:all:logged       # writes per-agent logs to logs/{api,pm,alm,router,executor}.log
```

You should see:

```
[pm]       pg-gossip connected
[router]   pg-gossip connected
[router]   pg-gossip listening { topic: 'swarm.pm.allocation', ... }
[executor] keeperhub mcp tools { count: 30 }
[*]        ready
```

**Terminal 3 — Frontend dashboard**

```bash
cd ~/shiva/open-agents/defi-swarm-newtab
npm run dev                  # Vite dev server on http://localhost:5173
```

Open `localhost:5173` in Chrome (NOT as a chrome-extension origin — `window.ethereum` won't be available there). Connect MetaMask, click **Delegate** to register all 4 agents for the EOA.

## Fund the KH wallet (one-time)

The agents execute swaps from a KeeperHub-managed wallet, not your EOA. Fund it once with native ETH:

```bash
cd ~/shiva/open-agents/defi-swarm-newtab/agents
npx tsx scripts/check-keeperhub-balances.ts   # prints the KH wallet address
# then send ~0.005 ETH from MetaMask to that address
```

## Common operations

```bash
cd ~/shiva/open-agents/defi-swarm-newtab/agents

# Inspect database state (sessions, users, intents, agent state)
npx tsx scripts/inspect.ts

# Force PM to tick the funded EOA on the next poll cycle
npx tsx scripts/force-tick.ts

# Backfill missing pm/router sessions for the funded EOA
npx tsx scripts/backfill-sessions.ts

# Decode any KH-submitted mainnet tx
npx tsx scripts/inspect-tx.ts 0x...

# Switch a user's risk profile (also via the dashboard UI)
curl -X PUT http://localhost:8787/api/users/<safe>/profile \
  -H 'content-type: application/json' \
  -d '{"riskProfile":"aggressive","resetCustom":true}'
```

## Watching the pipeline

```bash
cd ~/shiva/open-agents/defi-swarm-newtab/agents

# Full end-to-end flow per intent
grep -E "ticking|allocation received|routed|wrap|approve|swap landed|execute failed" \
  logs/pm.log logs/router.log logs/executor.log | tail -40

# Just the gossip transport diagnostic
grep "allocation received" logs/router.log
```

`[router] allocation received via pg` = Postgres LISTEN/NOTIFY delivered it (instant). `via db-poll` = the resilience fallback caught it. `via axl` = AXL gossip carried it (only fires in multi-host deploys).

## Architecture in one paragraph

PM observes the user's EOA portfolio via Zerion every cadence tick, asks Groq Llama 3.3 70B for a target allocation matching the user's risk profile, persists it as a `pending` intent, and publishes on three transports in parallel: AXL gossip (multi-host production), Postgres `LISTEN/NOTIFY` (instant single-host), and the always-on DB-poll fallback. Router subscribes to all three; whichever delivers first wins via an atomic `pending → netted` claim. Router decomposes the allocation into pair swaps and dispatches each to Executor. Executor goes through KeeperHub MCP — wraps native ETH to WETH on demand, refreshes router allowance if needed, then calls `uniswap/swap-exact-input`. The dashboard polls `/api/status/<safe>` every second to render live activity.

## Stopping

```bash
# Ctrl-C the npm run dev:all:logged terminal
pkill -f "shiva/axl/node"    # stops AXL daemon
```
