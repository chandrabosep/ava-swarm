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

> _To be filled in as we integrate. Below are the prompts we're
> tracking against._

- **What worked:**
- **What didn't:**
- **DX friction:**
- **Docs gaps:**
- **Bugs hit:**
- **Endpoints we wish existed:**

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
