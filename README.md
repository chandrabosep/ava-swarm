# Ava Swarm — New Tab Extension

A Chrome extension that overrides the new-tab page with a daily.dev-style **DeFi
dashboard**, backed by a 4-agent swarm (Portfolio Manager, ALM, Intent Router,
Swap Executor).

---

## 🏁 Speedrun: Agentic Payments (Avalanche)

**This build pivots the swarm onto Avalanche Fuji for the *Agentic Payments*
Speedrun — "agents that hire agents," combining x402 + ERC-8004.**

The lead agent (PM) splits a job into sub-tasks, ranks specialist agents by
their **ERC-8004 reputation**, **pays each one per task via x402** (USDC on
Fuji, gasless, no human in the loop), then writes **ERC-8004 feedback** that
changes who ranks highest next round.

### Delta — what existed before vs. what's new for this Speedrun

| Already built (pre-Speedrun) | New for this Speedrun |
|---|---|
| 4-agent swarm + LLM PM loop + AXL/Postgres plumbing | ERC-8004 `IdentityRegistry` + `ReputationRegistry` (`contracts/src/erc8004/`), deployed to Fuji |
| React new-tab dashboard shell | `@swarm/marketplace` — x402-gated specialist endpoints (`/quote-route`, `/risk-check`, `/price`) |
| Uniswap-v4 / KeeperHub execution on Ethereum L2s | PM **buyer loop** (`agents/pm/src/hire.ts`): reputation-ranked hiring, x402 USDC payment, ERC-8004 feedback |
| Chains: Unichain / Base / Mainnet | Repointed end-to-end to **Avalanche Fuji** (43113); on-chain agent identity at boot; reputation + live-payment dashboard panel |

The pre-Speedrun Uniswap/KeeperHub/Zerion tick loops still exist but idle on
Fuji (no user sessions) — the active demo path is x402 + ERC-8004.

### Run the demo

```sh
# 1. Deploy the ERC-8004 registries to Fuji
cd contracts && forge test                       # registries pass unit tests
forge script script/DeployErc8004.s.sol:DeployErc8004 \
  --rpc-url avalanche-fuji --broadcast --private-key $DEPLOYER_PRIVKEY
# paste the two logged addresses into agents/.env (ERC8004_*_ADDRESS)

# 2. Configure + fund (see agents/.env.example)
#    - USE_TESTNET=true, ERC8004_* addresses, X402_FACILITATOR_URL
#    - fund the PM (buyer) wallet with Fuji test-USDC + a little AVAX
#      from https://faucet.avax.network

# 3. Boot everything: agents register ERC-8004 identities, marketplace
#    serves x402 paywalls, PM starts hiring.
cd agents && npm install && npm run dev:all

# 4. Watch the dashboard's "Agent Marketplace" panel: reputation scores,
#    live x402 payments, and Snowtrace links to every settlement.
npm run dev   # extension dev server (repo root)
```

See [the agents README](agents/README.md) for the full backend layout.

---

> **Scope right now**: extension shell + Reown AppKit wallet connect. No agent
> runtime, no Uniswap, no KeeperHub, no real data feeds. Agent cards, portfolio
> numbers, intents log, and news items are **mock placeholders** so the layout
> is ready for wiring in later phases.

## Stack

- Vite + React + TypeScript
- Manifest V3 (`chrome_url_overrides.newtab` → `index.html`)
- TailwindCSS, dark theme (Linear/Vercel-leaning)
- Reown AppKit + Wagmi adapter, viem, `@tanstack/react-query`
- `@crxjs/vite-plugin` for manifest + dev HMR

## Prerequisites

- Node 20+ (Node 22 tested)
- A Reown AppKit project ID — free at <https://cloud.reown.com>

## Setup

```sh
cp .env.example .env
# edit .env and paste your Reown project id
npm install --legacy-peer-deps
```

> **`--legacy-peer-deps` is required.** `@reown/appkit-adapter-wagmi` pulls
> a transitive `accounts` package whose peer-dep graph trips npm's strict
> resolver. The flag is harmless here — versions are pinned in `package.json`.

## Develop

```sh
npm run dev
```

Vite serves the dashboard at <http://localhost:5173>. To preview it as a real
extension while developing, run `npm run build` and load the `dist/` folder
(see below) — `@crxjs/vite-plugin` supports HMR for unpacked extensions when
loaded from `dist/` after a build.

## Build

```sh
npm run build
```

This produces a self-contained, unpacked extension at `dist/`.

## Load in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked** and select the `dist/` folder
4. Open a new tab — the dashboard renders
5. Click the connect button in the header — the Reown AppKit modal opens

To pick up code changes, click **Reload** on the extension card after each
`npm run build`.

## Project layout

```
src/
  config/        # appkit, wagmi, chains
  components/
    layout/      # Header, Sidebar, RightRail
    portfolio/   # SummaryCards, AllocationChart
    agents/      # AgentCard, AgentStatusPanel
    news/        # NewsFeed, NewsCard
    common/      # Button, Surface, Badge
  hooks/         # useWallet
  lib/           # format helpers, mock data
  types/         # Agent, Intent, NewsItem
  pages/NewTab.tsx
  App.tsx
  main.tsx
public/
  icons/         # 16 / 48 / 128 placeholder icons
manifest.config.ts  # @crxjs/vite-plugin manifest source
```

## Environment

`.env` (gitignored) — copy from `.env.example`:

```
VITE_REOWN_PROJECT_ID=
```

If the project id is missing the dashboard still renders, but the wallet modal
will be unhappy. Watch the browser console for the warning logged by
`src/config/appkit.ts`.

## Networks

Configured chains: **Avalanche Fuji** (C-Chain testnet, the Speedrun target)
and **Avalanche** (C-Chain mainnet, optional bonus). The set lives in
`src/config/chains.ts` and `src/config/appkit.ts`; explorer links
(`src/lib/explorer.ts`) point at Snowtrace. `USE_TESTNET` (env
`VITE_USE_TESTNET` / `USE_TESTNET`) flips the whole stack between Fuji and
mainnet.

## Scripts

| Script              | What                          |
| ------------------- | ----------------------------- |
| `npm run dev`       | Vite dev server               |
| `npm run build`     | Type-check + build to `dist/` |
| `npm run typecheck` | `tsc --noEmit`                |
| `npm run lint`      | ESLint over `src/`            |
| `npm run preview`   | Preview the production build  |

## Out of scope (intentionally — coming in later phases)

- AI agent logic, runtime, or orchestration
- Gensyn AXL nodes, P2P comms, MCP, A2A messaging
- Uniswap v3/v4, Universal Router, Permit2 integration
- KeeperHub integration
- Real news feed (RSS / API)
- Real portfolio data
- Intent netting / routing logic

The shell exists so those layers can drop in cleanly.
