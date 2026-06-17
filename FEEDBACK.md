# Builder Feedback — Uniswap Developer Platform

This file is required for the [Uniswap Foundation prize](https://ethglobal.com/events/openagents/prizes/uniswap-foundation).
It will be filled in throughout the hackathon as we build against the
Uniswap API and v4 SDK. Below is the running log; we'll polish before
final submission.

## What we're building

DeFi Swarm — a Chrome extension new-tab dashboard backed by a 4-agent
swarm (Portfolio Manager, Active Liquidity Manager, Intent Router, Swap
Executor) that manages a user's Safe smart account. Two of the four
agents touch Uniswap directly:

- **Executor** — uses the Uniswap **Trading API** to fetch quotes and
  build Universal Router calldata; signs and submits via KeeperHub.
- **ALM** — uses Uniswap's **v4 SDK** to read pool state, compute
  optimal LP ranges, and build `modifyLiquidities` calldata.

## Trading API — running notes

> _Updated as we integrate. See `agents/executor/src/uniswap.ts`._

- **What worked:**
  - The `/quote` + `/swap` two-step is clean to wrap: one quote shape,
    one swap shape. Less ad-hoc than building Universal Router calldata
    by hand.
  - `swapper` parameter accepting an arbitrary recipient (not just msg.sender)
    is exactly right for Safe smart-account flows where the EOA submitting
    a UserOp differs from the on-behalf-of account.
- **What didn't:**
  - _to be filled as we hit issues_
- **DX friction:**
  - The boundary between "this field is in the response root" vs "in
    `quote` / `swap` sub-objects" required reading a sample response to
    figure out — a more uniform shape (`{ amountIn, route, calldata }`
    flat) would be friendlier.
- **Docs gaps:**
  - _to be filled_
- **Bugs hit:**
  - _to be filled_
- **Endpoints we wish existed:**
  - A combined `/swap-or-quote-then-swap` that returns calldata in one
    round-trip. Two sequential network calls per swap on a low-latency
    agent path adds noticeable wall-time.

## v4 SDK — running notes

- **What worked:**
- **What didn't:**
- **DX friction:**
- **Docs gaps:**
- **Bugs hit:**
- **Missing primitives:**

## Suggested improvements

> _Synthesized list once we've shipped. The above sections feed into this._

---

## Repo

- `agents/executor/` — Trading API integration
- `agents/alm/` — v4 SDK integration
- `src/` — extension dashboard that observes both
