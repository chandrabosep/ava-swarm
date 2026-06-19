-- Repurpose swarm_settings for Moltbook agent identity.
-- The hermes_* columns were added in 20260501000000 but the UI flow they
-- backed was the wrong abstraction (the swarm doesn't hold a Hermes API
-- key — Hermes-style agents hold service API keys like Moltbook's).

ALTER TABLE "swarm_settings"
    DROP COLUMN "hermes_enabled",
    DROP COLUMN "hermes_api_key",
    DROP COLUMN "hermes_model",
    DROP COLUMN "hermes_base_url",
    DROP COLUMN "hermes_skill",
    ADD COLUMN  "moltbook_api_key"            TEXT,
    ADD COLUMN  "moltbook_agent_name"         TEXT,
    ADD COLUMN  "moltbook_claim_url"          TEXT,
    ADD COLUMN  "moltbook_verification_code"  TEXT,
    ADD COLUMN  "moltbook_claimed_at"         TIMESTAMP(3);
