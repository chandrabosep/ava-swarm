-- One-shot cleanup pass. Two things:
--   1. Any Intent row marked 'executed' without a real txHash event is
--      a corpse from before the truth-in-status fix → flip to 'failed'.
--   2. Any phantom mainnet Router row leftover from the chain-fix
--      migration → drop it entirely so the dashboard stops showing
--      "on mainnet" rows in a testnet build.
--
-- Safe to run multiple times — only touches rows that match.
-- Run from your psql/Supabase SQL editor:
--   psql "$DATABASE_URL" -f cleanup-fake-executed.sql

-- 1. Demote fake-executed swaps
UPDATE intents
SET status = 'failed', updated_at = NOW()
WHERE status = 'executed'
  AND from_agent <> 'pm'
  AND id::text NOT IN (
    SELECT (payload ->> 'intentId')
    FROM events
    WHERE kind = 'intent.executed'
      AND payload ->> 'txHash' ~ '^0x[0-9a-fA-F]{64}$'
  );

-- 2. Delete mainnet Router rows in a testnet build. Replace `true` with
--    `false` in the WHERE if you have a mixed mainnet+testnet history
--    you don't want to nuke. By default this cleans everything that
--    routed against ethereum/base/unichain mainnets.
DELETE FROM intents
WHERE from_agent = 'router'
  AND payload ->> 'chain' IN ('mainnet', 'base', 'unichain');

-- Also wipe their corresponding events so the dashboard doesn't dangle.
DELETE FROM events
WHERE kind IN ('intent.routed', 'intent.executed', 'intent.failed', 'otc.advertised')
  AND (payload ->> 'intentId') NOT IN (SELECT id::text FROM intents);

-- Show how many rows ended up in each state:
SELECT status, COUNT(*) FROM intents GROUP BY status ORDER BY status;
