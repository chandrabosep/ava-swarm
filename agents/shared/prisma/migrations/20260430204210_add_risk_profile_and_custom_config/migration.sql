-- AlterTable
ALTER TABLE "users" ADD COLUMN     "custom_config" JSONB,
ADD COLUMN     "risk_profile" TEXT NOT NULL DEFAULT 'balanced';
