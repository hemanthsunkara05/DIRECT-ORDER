-- CreateEnum
CREATE TYPE "LoyaltyAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "LoyaltyLedgerType" AS ENUM ('ORDER_EARN', 'REDEMPTION', 'REFUND_CLAWBACK', 'ADMIN_ADJUSTMENT', 'EXPIRATION', 'REFERRAL_REWARD');

-- CreateEnum
CREATE TYPE "LoyaltyRedemptionStatus" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'EXPIRED', 'INVALIDATED');

-- AlterEnum
ALTER TYPE "OtpPurpose" ADD VALUE 'CUSTOMER_LOGIN';

-- CreateTable
CREATE TABLE "loyalty_accounts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "balance_points" INTEGER NOT NULL DEFAULT 0,
    "lifetime_earned" INTEGER NOT NULL DEFAULT 0,
    "lifetime_redeemed" INTEGER NOT NULL DEFAULT 0,
    "status" "LoyaltyAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "loyalty_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_ledger" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "type" "LoyaltyLedgerType" NOT NULL,
    "points" INTEGER NOT NULL,
    "reference_type" TEXT,
    "reference_id" UUID,
    "description" TEXT,
    "actor_type" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loyalty_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loyalty_redemptions" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "points" INTEGER NOT NULL,
    "discount_minor" BIGINT NOT NULL,
    "status" "LoyaltyRedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "reserved_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "loyalty_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_codes" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "referrer_customer_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "referred_customer_id" UUID NOT NULL,
    "referral_code" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "qualifying_order_id" UUID,
    "attributed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualified_at" TIMESTAMPTZ,
    "rewarded_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_accounts_customer_id_key" ON "loyalty_accounts"("customer_id");

-- CreateIndex
CREATE INDEX "loyalty_ledger_customer_id_created_at_idx" ON "loyalty_ledger"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "loyalty_redemptions_order_id_key" ON "loyalty_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "loyalty_redemptions_customer_id_status_idx" ON "loyalty_redemptions"("customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_customer_id_key" ON "referral_codes"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_customer_id_key" ON "referrals"("referred_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_qualifying_order_id_key" ON "referrals"("qualifying_order_id");

-- CreateIndex
CREATE INDEX "referrals_referrer_customer_id_status_idx" ON "referrals"("referrer_customer_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "customers_user_id_key" ON "customers"("user_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_redemptions" ADD CONSTRAINT "loyalty_redemptions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loyalty_redemptions" ADD CONSTRAINT "loyalty_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_customer_id_fkey" FOREIGN KEY ("referrer_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_customer_id_fkey" FOREIGN KEY ("referred_customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_qualifying_order_id_fkey" FOREIGN KEY ("qualifying_order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written raw SQL below this point (docs/02-database-schema.md
-- §6.1: "add raw-SQL migrations for anything Prisma cannot express"),
-- same treatment as Phase 14's promotions_active_code_key. Prisma's
-- generated section above already created `customers_user_id_key`
-- (a full unique on user_id, from `@unique` in schema.prisma — correct
-- and sufficient for the User<->Customer one-to-one). This is a
-- SEPARATE, additional constraint the DSL cannot express at all.

-- Correctness constraint (docs/01 §5.4: "unique on phone where
-- user_id IS NOT NULL; guests may repeat"). Two registered accounts
-- must never share a phone number; guests keep creating a fresh
-- Customer row per checkout (AMB-2) and are explicitly allowed to
-- repeat a phone across many such rows, so this cannot be a plain
-- (non-partial) unique index.
CREATE UNIQUE INDEX "customers_phone_account_key" ON "customers"("phone")
  WHERE "user_id" IS NOT NULL;

-- Correctness constraint (docs/01 §5.9: unique (type, reference_type,
-- reference_id) "for automatic types" — this is what makes BR-99's
-- "an order can never award twice" and BR-112's "issued once ...
-- through the ledger's uniqueness" true at the storage layer.
-- ADMIN_ADJUSTMENT is excluded (per docs/02 §6.3's reference DDL) since
-- an admin adjustment has no natural reference_id uniqueness to key
-- off — an admin may legitimately adjust the same customer's balance
-- more than once for unrelated reasons. Rows with a NULL reference_id
-- are excluded too: NULLs never collide under a plain unique index
-- regardless, but the explicit WHERE keeps the intent literal.
CREATE UNIQUE INDEX "loyalty_ledger_ref_key" ON "loyalty_ledger"("type", "reference_type", "reference_id")
  WHERE "reference_id" IS NOT NULL AND "type" <> 'ADMIN_ADJUSTMENT';

-- Correctness constraint (BR-109: "self-referral is blocked by a
-- database CHECK, not only by application logic"). Prisma's schema DSL
-- cannot express CHECK constraints at all (same limitation already
-- documented on Order/OrderItem above), so this is entirely
-- hand-written — there is no Prisma-generated equivalent to diff
-- against.
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_no_self_referral"
  CHECK ("referrer_customer_id" <> "referred_customer_id");
