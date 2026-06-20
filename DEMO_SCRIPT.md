# Ava Swarm — Speedrun Demo Script

**Speedrun:** Agentic Payments · Team1 India · June 2026
**Theme fit:** Agents That Hire Agents + Reputation-Aware Payments (x402 + ERC-8004)
**Chain:** Avalanche Fuji (C-Chain testnet)
**Target length:** ~3:00 (trim to 2:00 if needed — cut Scene 6)
**Tone:** Confident, fast, "watch this actually happen on-chain."

---

## Before you hit record (checklist)

- Fund the **PM buyer wallet** `0xAe3d…7Fc1` with Fuji USDC (faucet.circle.com → Avalanche Fuji) + a little AVAX. This is what makes the x402 payments settle live.
- Run the backend: `cd agents && npm run dev:all` (marketplace + PM hire loop).
- Fire a fresh round right before recording: `npx tsx --env-file=.env scripts/hire-once.ts` so the feed has recent green settlements.
- Dashboard: `VITE_DEMO_FEED=true` (feed/portfolio polished) — the **Agent Marketplace panel is always live testnet**, so its x402 rows + Snowtrace links are real.
- Have a Snowtrace tab ready: `https://testnet.snowtrace.io`.
- Pick the wallet `0x56b5…7012` connected so the HUD is populated.

---

## Scene 1 — Hook (0:00–0:15)

**[SCREEN]** Full dashboard, black/red HUD. Slow zoom on the "Agent Marketplace · x402 + ERC-8004" panel.

**VO:**
> "This is an AI treasury that doesn't just trade — it *hires other AI agents* to do the work, pays them per task in real USDC, and decides who to trust from their on-chain reputation. No humans, no checkout, no accounts. Let me show you."

---

## Scene 2 — The problem (0:15–0:35)

**[SCREEN]** Portfolio panel — Total Value, Stable Ratio, Allocation bar.

**VO:**
> "Autonomous agents are great at *deciding* — but the moment they need data, a quote, or a risk check, they hit a wall: there's no clean way for one agent to pay another for a service. Today that's API keys, invoices, and humans in the loop. Agentic payments fix that — and we built a working swarm on top of two primitives: x402 for payment, ERC-8004 for trust."

---

## Scene 3 — Meet the swarm (0:35–0:55)

**[SCREEN]** Scroll to **Agent Swarm** — PM, ALM, Router, Executor all online. Then **Smart Account** (EIP-7702 delegated).

**VO:**
> "Meet Ava Swarm: a Portfolio Manager agent leading three specialists — a Router, a Risk checker, and a Price oracle — each with its own on-chain identity and its own wallet. The PM runs an EOA-as-account via EIP-7702 delegation on Avalanche, so it can act autonomously, on-chain, within policy."

---

## Scene 4 — It's alive: risk profiles drive behavior (0:55–1:30)

**[SCREEN]** **Risk Profile** card. Click **Aggressive**, then **Degen**. The **Allocation** bar re-shapes; the **Agent Feed** stacks new PM → Router → Executor ticks live.

**VO:**
> "The swarm reacts in real time. I switch the risk profile to *Aggressive* — and the Portfolio Manager immediately re-decides: cut stables, concentrate into AVAX, and you can watch it think in the live feed — propose allocation, route the swap, settle the receipt. Flip it to *Degen* and the whole strategy and cadence change again. This is the agent reasoning loop, running continuously."

---

## Scene 5 — THE MONEY SHOT: agents hiring agents (1:30–2:20)

**[SCREEN]** **Agent Marketplace** panel. Left: specialists ranked by ERC-8004 reputation. Right: **Live x402 payments** filling in. Hover a row; click the **`pay↗`** link → Snowtrace opens a **real USDC transfer** on Fuji. Back to dashboard; click **`rep↗`** → the ERC-8004 feedback tx.

**VO:**
> "Here's the core. The Portfolio Manager needs a route quote, a risk check, and a price. Instead of calling a hard-coded API, it *hires specialist agents* off an open marketplace. Each endpoint is gated by **x402** — HTTP 402, Payment Required — so the PM signs a USDC payment and gets the result in one call.
>
> Watch — every row here is a real settlement on Avalanche Fuji. I click 'pay' — **that's an on-chain USDC transfer on Snowtrace**, agent-to-agent, no human, no account. And it ranks *who* to hire by **ERC-8004 reputation** — then after each job it writes feedback back on-chain, which changes who gets hired next round. Payment and trust, both autonomous, both verifiable."

---

## Scene 6 — Avalanche + the delta (2:20–2:40)

**[SCREEN]** Header pills: "NET Avalanche Fuji · PAY x402 · ERC-8004". Quick flash of Snowtrace txs list.

**VO:**
> "All of it runs on Avalanche C-Chain — fast, cheap finality is what makes per-task micro-payments between agents actually viable. For this Speedrun we added the full x402 buyer loop, deployed the ERC-8004 identity and reputation registries to Fuji, and wired live reputation-ranked hiring into the dashboard — on top of an existing autonomous treasury we already had."

---

## Scene 7 — Close (2:40–3:00)

**[SCREEN]** Pull back to the full dashboard, feed still ticking.

**VO:**
> "Ava Swarm: an autonomous treasury where AI agents pay each other in real stablecoins and trust each other through on-chain reputation. Agentic payments, working end-to-end, live on Avalanche. Thanks for watching."

**[SCREEN]** End card: project name, team code **T1-ZWSTYHW6**, "Built on x402 + ERC-8004 · Avalanche Fuji".

---

## One-liner (for the submission form)

> An autonomous treasury swarm where a lead AI agent hires specialist agents off an open marketplace, pays them per-task in USDC via x402, and ranks who to trust using ERC-8004 reputation — every payment and every reputation update settling live on Avalanche Fuji.

## Judging-criteria cheat sheet (say these words on camera)

- **Value proposition:** "agents can finally pay each other for services — no accounts, no humans."
- **Technical complexity:** "x402 per-call payments + ERC-8004 identity & reputation registries + EIP-7702 delegated account, four-agent swarm."
- **Avalanche usage:** "deployed and settling on Avalanche C-Chain (Fuji); cheap fast finality makes agent micro-payments viable."

## If the live x402 settlement isn't ready at record time

Record Scenes 1–4 + 6–7 live, and for Scene 5 either (a) show the marketplace with the funded round you pre-fired via `hire-once.ts`, or (b) narrate over the panel and open one **real** Snowtrace tx you generated earlier. Never click a link you haven't confirmed resolves.
