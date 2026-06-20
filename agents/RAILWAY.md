# Deploying the DeFi Swarm backend to Railway

Single Railway service runs the entire backend in one container:
**AXL daemon + api + pm + alm + router + executor.** Agents talk to
the local AXL daemon over `localhost:9002`; the API is exposed at
Railway's public URL on `$PORT`.

## What's in this folder

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: AXL Go binary → Node deps + tsc → slim runtime |
| `docker-entrypoint.sh` | Boots AXL daemon (with retry probe), then `exec npm start` |
| `railway.json` | Tells Railway to use the Dockerfile + healthcheck `/api/health` |
| `.dockerignore` | Excludes `node_modules/`, `dist/`, `.env*`, logs, AXL keys |

## One-time setup

```bash
# Install the Railway CLI
brew install railway      # macOS
# or: npm i -g @railway/cli

railway login
railway init              # from repo root, creates a project
railway link              # link the current directory to the project
```

## Postgres

Railway's PG add-on is the easiest path:

```bash
railway add --plugin postgresql
railway variables                # confirm DATABASE_URL got injected
```

The image runs `prisma migrate deploy` on every boot, so the schema is
applied automatically on first deploy.

If you need a separate `DIRECT_URL` (Supabase pooler vs direct port),
set it explicitly:

```bash
railway variables set DIRECT_URL="postgresql://user:pass@host:5432/db"
```

## Required env vars

Set these via `railway variables set KEY=VALUE` or the dashboard:

```
# Required
DATABASE_URL              # provided by Railway PG add-on
DIRECT_URL                # same DB, port 5432 (Supabase users), or omit
GROQ_API_KEY              # from console.groq.com
KEEPERHUB_API_KEY         # from app.keeperhub.com
KEEPERHUB_WALLET_ADDRESS  # the org-managed wallet KH executes from
UNISWAP_API_KEY           # from developers.uniswap.org
ZERION_PROXY_URL          # mainnet portfolio proxy (CF Worker URL)
RPC_MAINNET               # alchemy / infura mainnet
RPC_BASE
RPC_UNICHAIN
RPC_SEPOLIA               # for testnet builds
RPC_BASE_SEPOLIA
ALCHEMY_API_KEY           # testnet portfolio path
USE_TESTNET=false         # flip true for sepolia + base-sepolia primary

# Per-agent service keys (Model B — one keypair per role)
PM_SERVICE_PRIVKEY=0x...
ALM_SERVICE_PRIVKEY=0x...
ROUTER_SERVICE_PRIVKEY=0x...
EXECUTOR_SERVICE_PRIVKEY=0x...

# AXL endpoints — agents → daemon. Default localhost:9002 works since
# the daemon runs in the same container.
AXL_PM_ENDPOINT=http://127.0.0.1:9002
AXL_ALM_ENDPOINT=http://127.0.0.1:9002
AXL_ROUTER_ENDPOINT=http://127.0.0.1:9002
AXL_EXECUTOR_ENDPOINT=http://127.0.0.1:9002

# Internal API auth (for KH webhook endpoints)
SWARM_INTERNAL_KEY=<random-32-byte-hex>

# Frontend that's allowed to call the API (CORS)
API_ALLOWED_ORIGINS=https://your-extension-id.chrome,https://your-domain
```

Optional:

```
LLM_PROVIDER=groq             # or 'hermes'
HERMES_API_KEY=               # only if LLM_PROVIDER=hermes
HERMES_BASE_URL=
HERMES_MODEL=Hermes-4-405B
EXECUTOR_MOCK=false           # true skips Uniswap + KH for demo recordings
ROUTER_PREFLIGHT=true         # default true on testnet
MAX_SWAP_USD=                 # cap per-swap notional, e.g. 250 for testnet
PM_PORTFOLIO_FROM=eoa         # 'eoa' (default) or 'kh' for legacy Model B
PM_DEBATE_WINDOW_MS=2500      # ms PM waits for peer feedback per tick
PORTFOLIO_SOURCE=             # 'alchemy' to force testnet client on mainnet
AXL_DISABLED=false            # true → skip AXL daemon, agents use PG-only
AXL_BOOTSTRAP_PEERS=          # tls://host:port,... for cross-host mesh
```

Bulk-import the lot via:

```bash
railway variables set $(cat agents/.env | grep -v '^#' | xargs)
```

## Deploy

From the repo root:

```bash
railway up
```

Railway:
1. Builds `agents/Dockerfile` (clones AXL, builds Go binary, installs Node deps, runs `tsc -b`).
2. Starts the container; entrypoint applies migrations, boots AXL daemon, then `npm start` fans out the 5 agents via concurrently.
3. Hits `/api/health` to confirm the API is up.

You'll see logs prefixed `[api]`, `[pm]`, `[alm]`, `[router]`,
`[executor]` (concurrently's `-n` tags), plus `[entrypoint]` lines for
the AXL boot probe.

## Cross-host AXL (multi-region mesh)

Default deploy is single-host: one Railway service, one AXL daemon,
one container. AXL gossip only loops back to itself — agents on the
host see all messages because they share one daemon.

For a production AXL story (the "AXL prize" angle), deploy *another*
Railway service in a different region and federate them:

```bash
# In service A, expose AXL TLS on a Railway internal hostname
# and grab the URL from the dashboard, e.g.
#   service-a.railway.internal:9101

# In service B, set:
railway variables set AXL_BOOTSTRAP_PEERS=tls://service-a.railway.internal:9101

# Redeploy:
railway up
```

You'll see `axl up {peers: 2}` in service B's logs and message rates
above 0 in service A's `/topology` endpoint.

## What gets exposed publicly

- `$PORT` (the Express API at `/api/*`) — only port Railway routes
  inbound traffic to. The Chrome extension talks to this.
- AXL `9101` is bound to `0.0.0.0` inside the container but Railway
  doesn't route external traffic to it. Internal service-to-service
  in the same project can reach it via `service.railway.internal:9101`.
- AXL `9002` (HTTP API) is bound to `0.0.0.0` but never exposed —
  agents call it via `localhost`.

## Useful commands

```bash
railway logs --service <name>          # tail logs
railway run npm --workspace shared run prisma:migrate -- deploy
railway shell                          # shell into the live container
railway variables                      # list current env
railway redeploy                       # re-run the latest deploy
```

## Common issues

**"Could not find Prisma Schema"** — happens when the `npm install`
step skipped the postinstall `prisma generate` because the schema
hadn't been copied yet. Our Dockerfile uses `npm install --ignore-scripts`
then runs `prisma:generate` explicitly after the source copy. If you
see this, rebuild from a clean state: `railway redeploy --no-cache`.

**`AXL did not come up in 10s` in entrypoint logs** — the Go binary
didn't start. Most common causes: AXL repo's main branch changed its
build invocation (open `axl-build` stage and adjust `go build ./...`),
or the binary expects a flag we didn't pass (`axl --help` in
`railway shell` to inspect).

**Agents ticking but no swaps execute** — the KH wallet is empty.
See `agents/.env.example` and the `MAX_SWAP_USD`, `EXECUTOR_MOCK`
notes; for a demo without funding, set `EXECUTOR_MOCK=true`.

**Cross-tenant OTC matches don't fire** — both swarms need to be on
the same AXL mesh. Either run two Railway services and set
`AXL_BOOTSTRAP_PEERS` between them, or test locally with two browser
tabs against the same single-host service.

## Sanity-checking the deploy

```bash
# After railway up reports success:
curl https://<your-railway-url>/api/health
# {"ok":true,"now":"2026-05-03T..."}

# Check AXL is alive inside the container:
railway shell
> curl http://127.0.0.1:9002/topology
> tail /tmp/axl.log
```
