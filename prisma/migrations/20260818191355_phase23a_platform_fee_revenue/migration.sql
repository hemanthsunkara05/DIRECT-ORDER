-- AlterTable
ALTER TABLE "daily_platform_metrics" ADD COLUMN     "platform_fee_revenue_minor" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "daily_restaurant_metrics" ADD COLUMN     "platform_fee_revenue_minor" BIGINT NOT NULL DEFAULT 0;
