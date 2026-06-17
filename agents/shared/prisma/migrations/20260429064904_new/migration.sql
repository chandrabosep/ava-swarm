-- CreateEnum
CREATE TYPE "AgentRole" AS ENUM ('pm', 'alm', 'router', 'executor');

-- CreateEnum
CREATE TYPE "IntentStatus" AS ENUM ('pending', 'netted', 'routed', 'executing', 'executed', 'failed', 'expired');

-- CreateTable
CREATE TABLE "users" (
    "safe_address" TEXT NOT NULL,
    "owner_eoa" TEXT NOT NULL,
    "chains" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("safe_address")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "safe_address" TEXT NOT NULL,
    "agent" "AgentRole" NOT NULL,
    "session_address" TEXT NOT NULL,
    "policy_hash" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intents" (
    "id" TEXT NOT NULL,
    "safe_address" TEXT NOT NULL,
    "from_agent" "AgentRole" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "IntentStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "safe_address" TEXT NOT NULL,
    "agent" "AgentRole",
    "kind" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_state" (
    "agent" "AgentRole" NOT NULL,
    "safe_address" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_state_pkey" PRIMARY KEY ("agent","safe_address")
);

-- CreateIndex
CREATE INDEX "sessions_agent_valid_until_idx" ON "sessions"("agent", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_safe_address_agent_key" ON "sessions"("safe_address", "agent");

-- CreateIndex
CREATE INDEX "intents_safe_address_status_idx" ON "intents"("safe_address", "status");

-- CreateIndex
CREATE INDEX "intents_status_created_at_idx" ON "intents"("status", "created_at");

-- CreateIndex
CREATE INDEX "events_safe_address_created_at_idx" ON "events"("safe_address", "created_at");

-- CreateIndex
CREATE INDEX "events_kind_created_at_idx" ON "events"("kind", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_safe_address_fkey" FOREIGN KEY ("safe_address") REFERENCES "users"("safe_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intents" ADD CONSTRAINT "intents_safe_address_fkey" FOREIGN KEY ("safe_address") REFERENCES "users"("safe_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_safe_address_fkey" FOREIGN KEY ("safe_address") REFERENCES "users"("safe_address") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_safe_address_fkey" FOREIGN KEY ("safe_address") REFERENCES "users"("safe_address") ON DELETE CASCADE ON UPDATE CASCADE;
