# DeFi Swarm — New Tab Extension

A Chrome extension that overrides the new-tab page with a daily.dev-style **DeFi
dashboard**. This repo is the **UI shell + wallet integration** for what will
later become the surface for a 4-agent swarm (Portfolio Manager, ALM, Intent
Router, Swap Executor) running as Gensyn AXL nodes.

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

Configured chains: **Unichain**, **Base**, **Mainnet**. The set lives in
`src/config/chains.ts` and `src/config/appkit.ts` — adjust there.

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
