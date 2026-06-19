-- Repurpose swarm_settings as a generic skill connector.
-- The moltbook_* columns from 20260501010000 baked the wrong abstraction
-- (Moltbook-specific). Replace with a generic skill+key store so any
-- Hermes-style skill (Moltbook is one example) can be installed.

ALTER TABLE "swarm_settings"
    DROP COLUMN "moltbook_api_key",
    DROP COLUMN "moltbook_agent_name",
    DROP COLUMN "moltbook_claim_url",
    DROP COLUMN "moltbook_verification_code",
    DROP COLUMN "moltbook_claimed_at",
    ADD COLUMN  "skill_name"          TEXT,
    ADD COLUMN  "skill_version"       TEXT,
    ADD COLUMN  "skill_description"   TEXT,
    ADD COLUMN  "skill_content"       TEXT,
    ADD COLUMN  "skill_api_key"       TEXT,
    ADD COLUMN  "skill_installed_at"  TIMESTAMP(3);
