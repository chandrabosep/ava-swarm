-- Per-agent skill installs. Replaces the single-row swarm_settings.skill_*
-- columns with a real table so each swarm agent (PM, ALM, Router, Executor)
-- can have its own self-registered identity against any number of skills.
--
-- The connector's auto-register flow writes register-response data here:
-- api_key (server-only), claim_url + verification_code (shown to the human),
-- claim_status (poller updates pending_claim → claimed once verified).
--
-- swarm_settings.skill_* columns are intentionally NOT dropped here. They
-- get a follow-up migration once the new flow has soaked.

CREATE TABLE "skills" (
    "id"                TEXT NOT NULL,
    "agent_role"        "AgentRole" NOT NULL,
    "name"              TEXT NOT NULL,
    "version"           TEXT,
    "description"       TEXT,
    "source_url"        TEXT,
    "content_hash"      TEXT NOT NULL,
    "content"           TEXT NOT NULL,
    "allowed_hosts"     TEXT NOT NULL DEFAULT '',
    "register_endpoint" TEXT,
    "status_endpoint"   TEXT,
    "api_base"          TEXT,
    "api_key"           TEXT,
    "claim_url"         TEXT,
    "verification_code" TEXT,
    "claim_status"      TEXT NOT NULL DEFAULT 'unknown',
    "last_heartbeat_at" TIMESTAMP(3),
    "registered_name"   TEXT,
    "installed_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "skills_agent_role_name_key" ON "skills"("agent_role", "name");
CREATE INDEX "skills_agent_role_idx" ON "skills"("agent_role");
