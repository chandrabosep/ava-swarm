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
  - **Single-call quote.** `/quote` returns route + prices + the
    Universal Router `methodParameters` (calldata, value, target) in
    one response. Wrapped in 80 lines of TS. Exactly the shape an agent
    wants — no quote→swap round-tripping on the hot path.
  - `swapper` parameter accepting an arbitrary recipient (not just
    msg.sender) is exactly right for Safe smart-account flows where
    the EOA submitting a UserOp differs from the on-behalf-of account.
  - Smart Order Routing across v2/v3/v4 transparently — agent code
    only needs the token pair + amount, never has to think about pool
    topology.
- **What didn't:**
  - We initially built a two-call flow (`/quote` then `/swap`) before
    realizing `/quote` already returned methodParameters. The docs
    leave it ambiguous which version of the API is current; the video
    walkthrough we found showed single-call, and that's what shipped
    in production.
- **DX friction:**
  - The shape of `methodParameters` lives nested inside `quote` in
    some response paths and at root in others. Our client tolerates
    both, but a uniform shape would be cleaner.
  - Per-chain numeric ids in `tokenInChainId` / `tokenOutChainId` —
    we'd love a string alias (`"unichain"`) since most agent code
    speaks chain names, not chain ids.
- **Docs gaps:**
  - The Permit2 signature-based approval flow is described in the
    Permit2 docs separately; integrating against the Trading API for
    "swap with embedded Permit" required reading both. A combined
    flow doc would shorten the path significantly.
- **Bugs hit:**
  - `slippageTolerance` accepts both a fraction (0.005) and a percent
    (0.5) depending on which doc page you read. We default to percent
    because that's what the most-recent example showed.
- **Endpoints we wish existed:**
  - A `POST /quote-batch` that takes an array of pairs and returns
    quotes in one call. Our PM tick re-allocates across multiple
    pairs simultaneously and we'd love to do them in one HTTP roundtrip
    rather than N sequential calls.
  - A `POST /quote/internal-match-hint` that lets a caller publish
    "I'm about to swap X for Y" and receive back "we see N other
    pending swaps in the same direction; expect ~M bps better than
    quoted price if you can wait 30s." Agent OTC layers like ours
    would consume this.

## Novel primitive: agent-mediated OTC matching

We built a layer on top of the Trading API that we think is the
"primitive Uniswap hasn't seen yet" your prize copy mentioned:
**agent-to-agent OTC matching over a peer-to-peer mesh, with Uniswap
as the liquidity backstop.**

How it works (agents/router/src/otc.ts):

1. PM proposes an allocation change for user A → Router decomposes
   into pair swaps (sell USDC, buy ETH).
2. Before sending each swap to Executor, Router broadcasts an
   `OtcAdvert` on the AXL mesh (Gensyn's P2P comms).
3. Other Routers (serving other tenants) listen. If any of them have
   the opposite swap in their own pending pool at compatible size,
   they reply with `OtcConfirm`.
4. Matched: both sides settle Safe-to-Safe at mid-price, no Uniswap
   hit, no slippage, no MEV exposure.
5. Unmatched within a 5s window: Router falls through to Uniswap and
   the swap routes normally.

The pitch: Uniswap remains the backstop liquidity; agents save the
slippage on the volume they can match internally; the user keeps the
benefit either way. We think this is exactly the kind of agentic
finance primitive your team is fishing for.

## v4 SDK — running notes

> _Updated as we integrate. See `agents/alm/src/positions.ts` and
> `agents/alm/src/strategy.ts`._

- **What worked:**
  - `getPoolAndPositionInfo(tokenId)` returning everything we need (poolId,
    tickLower, tickUpper, liquidity) in one call is exactly the right shape
    for an LP-management agent — no chained reads.
  - Position-as-NFT means `balanceOf` + `tokenOfOwnerByIndex` is the
    standard ERC-721 dance, no v4-specific quirks for enumeration.
- **What didn't:**
  - `getSlot0(poolId)` exists in the helper but isn't on the canonical
    PoolManager ABI — had to use a separate StateView contract address.
    Easy to miss in docs.
- **DX friction:**
  - PoolManager addresses differ across Mainnet / Base / Unichain. We hardcoded
    a per-chain map; an SDK helper that resolves by chainId would prevent the
    inevitable copy-paste typo.
- **Docs gaps:**
  - The `tickSpacing → fee tier` mapping could be more discoverable from the
    SDK; we ended up reading hooks code to confirm canonical values.
- **Bugs hit:**
  - _to be filled_
- **Missing primitives:**
  - A canonical "is this position in range?" helper. Every LP integration
    re-implements the `currentTick ∈ [lower, upper]` check.
  - A "compute optimal new range for current price + fee tier + volatility"
    helper would let agents reuse Uniswap's own range-selection heuristic
    rather than rolling their own.

## Suggested improvements

> _Synthesized list once we've shipped. The above sections feed into this._

---

## Repo

- `agents/executor/` — Trading API integration
- `agents/alm/` — v4 SDK integration
- `src/` — extension dashboard that observes both
