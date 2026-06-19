# KeeperHub workflows

Each workflow is a self-contained JSON spec posted to KH's
`create_workflow` action. Together they cover every cross-agent
timing decision in the swarm — PM ticks, position checks, daily
reports — moving the orchestration off `setInterval` and onto KH.

Workflows in this directory:

| File | Trigger | What it does |
|---|---|---|
| `scheduled-tick.json` | cron, every 5 min | hits the agents API `/internal/tick` to kick PM round for every active session |
| `risk-change-apply.json` | webhook (`PUT /api/users/:wallet/profile`) | re-runs PM immediately when a user changes risk profile, instead of waiting for cadence |
| `alm-position-check.json` | cron, every 15 min | reads each user's v4 LP positions, fires a rebalance intent on drift |
| `treasury-report.json` | cron, daily at 00:00 UTC | compiles 24h PnL + intent counts + OTC savings into a digest, posts to webhook (Telegram / email) |

## Deploying

```
# from agents/
npm --workspace executor run kh:deploy-workflows
```

The deploy script (`agents/executor/scripts/deploy-workflows.ts`)
reads each JSON, posts to KH's MCP `create_workflow` tool, then
stores the returned `workflowId` in `agents/.env` so other agents
can reference them.

## Architecture note

Pre-Day-3 the swarm had **one** workflow type: `uniswap/swap-exact-input`
fired by the executor on each routed intent. PM ticking ran via Node
`setInterval` inside the PM process. ALM was fully dormant.

Post-Day-3 the swarm is **KH-orchestrated**:

- PM cadence comes from `scheduled-tick` (cron-driven, survives PM
  restarts)
- ALM monitoring comes from `alm-position-check`
- User-facing reports come from `treasury-report`
- Risk-profile changes are propagated immediately via
  `risk-change-apply`

KH is no longer just an execution sponsor — it's the swarm's
orchestration backbone.
