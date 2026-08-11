-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_DELIVERY');

-- CreateEnum
CREATE TYPE "PromotionRedemptionStatus" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED');

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PromotionType" NOT NULL,
    "value" INTEGER NOT NULL,
    "min_order_minor" BIGINT,
    "max_discount_minor" BIGINT,
    "starts_at" TIMESTAMPTZ,
    "ends_at" TIMESTAMPTZ,
    "usage_limit_total" INTEGER,
    "usage_limit_per_customer" INTEGER,
    "first_order_only" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_redemptions" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "customer_phone" TEXT NOT NULL,
    "order_id" UUID,
    "status" "PromotionRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "discount_minor" BIGINT NOT NULL,
    "reserved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "promotion_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotions_restaurant_id_idx" ON "promotions"("restaurant_id");

-- Correctness constraint, not a query-performance index (docs/01 §5.8:
-- "unique code where active and non-archived"; docs/02 §6.1: "add
-- raw-SQL migrations for anything Prisma cannot express"). Prisma's
-- schema DSL cannot express a partial unique index, so this is
-- hand-written rather than approximated with a plain index. Codes are
-- normalised to uppercase before being written (see
-- PromotionRepository), so this also structurally prevents "WELCOME50"
-- and "welcome50" coexisting as two simultaneously-active promotions.
CREATE UNIQUE INDEX "promotions_active_code_key" ON "promotions"("code")
  WHERE "is_active" = true AND "archived_at" IS NULL;

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_status_idx" ON "promotion_redemptions"("promotion_id", "status");

-- CreateIndex
CREATE INDEX "promotion_redemptions_promotion_id_customer_phone_status_idx" ON "promotion_redemptions"("promotion_id", "customer_phone", "status");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_redemptions_promotion_id_order_id_key" ON "promotion_redemptions"("promotion_id", "order_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
