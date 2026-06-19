-- CreateTable
CREATE TABLE "swarm_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "hermes_enabled" BOOLEAN NOT NULL DEFAULT false,
    "hermes_api_key" TEXT,
    "hermes_model" TEXT,
    "hermes_base_url" TEXT,
    "hermes_skill" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "swarm_settings_pkey" PRIMARY KEY ("id")
);
