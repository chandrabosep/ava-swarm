// Marketplace — the sellers' storefront for the "agents that hire agents" demo.
//
// Three of the swarm's agents (router, executor, alm) each expose ONE x402-
// gated endpoint. A caller (PM, the buyer) gets HTTP 402 with payment
// requirements, signs a USDC authorization, and retries; the hosted facilitator
// settles the payment on Avalanche Fuji and the handler runs. Each endpoint
// settles to that specialist's OWN wallet (payTo = its service address), so
// every payment traces to a distinct, ERC-8004-registered agent.
//
// The "work" itself (services.ts) is intentionally lightweight — the point is
// the autonomous payment + reputation loop, not the analytics.

import express from 'express';
import { paymentMiddleware, type Network, type RoutesConfig } from 'x402-express';

import { createLogger, env, serviceAddress, SPECIALISTS } from '@swarm/shared';
import { priceData, quoteRoute, riskCheck } from './services.js';

const log = createLogger('market');
const PORT = env.marketplacePort();
const network = env.x402Network() as Network;
const facilitator = { url: env.x402FacilitatorUrl() as `${string}://${string}` };

const app = express();
app.use(express.json({ limit: '64kb' }));

// Public discovery — no payment required. Lets a buyer (or the dashboard)
// learn who's selling what, at what price, and where the money goes.
app.get('/catalog', (_req, res) => {
  res.json({
    network,
    facilitator: facilitator.url,
    specialists: SPECIALISTS.map((s) => ({
      role: s.role,
      label: s.label,
      description: s.description,
      path: s.path,
      price: s.price,
      payTo: serviceAddress(s.role),
    })),
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// One x402 paywall per specialist, each settling to its own wallet. A request
// to a path this middleware doesn't own simply falls through to the next.
for (const s of SPECIALISTS) {
  const routes: RoutesConfig = {
    [s.path]: { price: s.price, network, config: { description: s.description } },
  };
  app.use(paymentMiddleware(serviceAddress(s.role), routes, facilitator));
}

// Handlers run ONLY after the matching paywall has verified + settled payment.
app.post('/quote-route', (req, res) => {
  const out = quoteRoute(req.body ?? {});
  log.info('sold quote-route', { tokenIn: out.tokenIn, tokenOut: out.tokenOut });
  res.json(out);
});

app.post('/risk-check', (req, res) => {
  const out = riskCheck(req.body ?? {});
  log.info('sold risk-check', { token: out.token, verdict: out.verdict });
  res.json(out);
});

app.post('/price', (req, res) => {
  const out = priceData(req.body ?? {});
  log.info('sold price', { token: out.token, sentiment: out.sentiment });
  res.json(out);
});

app.listen(PORT, () => {
  log.info('marketplace up', {
    port: PORT,
    network,
    facilitator: facilitator.url,
    sellers: SPECIALISTS.map((s) => `${s.role}:${s.path} (${s.price} → ${serviceAddress(s.role)})`),
  });
});
