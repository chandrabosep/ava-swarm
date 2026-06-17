# Agents — DeFi Swarm Backend

Multi-tenant backend services that act on user Safes via session keys
granted onchain in the extension's Activate Swarm flow.

## Architecture at a glance

```
┌──────────────┐         AXL pubsub          ┌──────────────┐
│   PM (LLM)   │──┐                       ┌──│   Router     │
└──────────────┘  │                       │  └──────────────┘
                  ├── allocation/rebalance┤            │
┌──────────────┐  │       intents         │            ▼  routed intents
│   ALM (v4)   │──┘                       │  ┌──────────────┐
└──────────────┘                          │  │   Executor   │
                                          │  └──────┬───────┘
                                          │         │
                                          │         ▼
                                          │  ┌──────────────┐
                                          │  │  KeeperHub   │──► Uniswap
                                          │  └──────────────┘     ↓
                                          │                    Safe (Smart
                                          │                     Sessions)
                                          ▼
                                   PostgreSQL (Supabase) — per-tenant
                                   sessions, intents, events, agent_state
```

Each agent:

- Runs as a separate Node process (`tsx`) — one OS process per agent.
- Connects to its own local AXL daemon for inter-agent messaging.
- Reads/writes its slice of state in shared Postgres via Prisma.
- Multi-tenant: serves N users keyed by Safe address.
- Holds a fixed service keypair; users grant policies pointing to it.

## Sponsor mapping

| Sponsor | Where it shows up |
|---|---|
| **Uniswap** | Executor uses the Trading API for routes; ALM uses v4 SDK |
| **Gensyn AXL** | All inter-agent comms (PM ↔ Router ↔ Executor / ALM) |
| **KeeperHub** | Executor's onchain submission path with retries + MEV protection |

## Setup

```sh
# 1. Create a Supabase project, grab pooler + direct URLs.

# 2. Generate an encryption key for session privkeys at rest.
openssl rand -hex 32

# 3. Fill the env.
cp .env.example .env
# edit .env

# 4. Install deps.
npm install

# 5. Generate Prisma client + run migrations on Supabase.
npm run prisma:generate
npm run prisma:migrate

# 6. Pull and run the AXL daemon (Docker).
cd axl-node && docker-compose up -d && cd ..

# 7. Run an agent.
npm run dev:executor   # or dev:pm / dev:alm / dev:router / dev:all
```

## Layout

```
agents/
  shared/        # @swarm/shared — DB, AXL, crypto, chain, types, env, log
    prisma/      # schema.prisma + migrations
  pm/            # Portfolio Manager  (Anthropic Claude)
  alm/           # Active Liquidity Manager  (Uniswap v4)
  router/        # Intent Router  (netting, venue selection)
  executor/      # Swap Executor  (Uniswap Trading API → KeeperHub)
  axl-node/      # docker-compose for the AXL binary
```

## Environment

See `.env.example`. The encryption key, Supabase URLs, sponsor API keys,
and AXL endpoints all live there.

## Multi-tenant model (Model B — shared service keys)

Each agent holds **one fixed keypair** loaded from env at boot
(`PM_/ALM_/ROUTER_/EXECUTOR_SERVICE_PRIVKEY`). All users grant their
Safe's Smart Sessions policy to the same set of public addresses. The
agent uses its single keypair to sign UserOps for any user; the per-user
caps + whitelists are enforced onchain by the Smart Sessions module.

**Why this over per-user keypairs (Model A):**
- No keypair-transmission flow needed (extension never holds privkeys).
- One round of env management instead of N (where N = number of users).
- Simpler audit story — every UserOp from this agent is signed by one
  known address, easy to grep onchain.

**Compromise model:** if a service privkey leaks, an attacker can sign
UserOps for every user who granted to that pubkey — but ONLY within each
user's per-user policy. With $1k/tx + $10k/day caps and a contract
whitelist, the worst case is bounded; the user's funds in the Safe
outside those caps are untouchable.

**User discovery:** agents listen for the Smart Sessions module's
`SessionEnabled` event filtered by their own service pubkey. When a Safe
emits it, the agent enrolls the user in its DB and starts serving them.
No login, no API keys — onchain truth.

## First-time deployment

1. Generate four privkeys: `openssl rand -hex 32` × 4.
2. Put them in `agents/.env` as `{PM,ALM,ROUTER,EXECUTOR}_SERVICE_PRIVKEY`.
3. Boot any agent (`npm run dev:executor`) — it logs its derived service
   address.
4. Copy the four addresses into `src/config/swarm.ts` in the extension.
5. Rebuild the extension. Now extensions and agents agree on identity.
