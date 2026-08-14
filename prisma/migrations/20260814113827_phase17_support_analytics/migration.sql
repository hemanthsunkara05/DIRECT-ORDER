-- CreateEnum
CREATE TYPE "SupportCaseCategory" AS ENUM ('ORDER', 'PAYMENT', 'DELIVERY', 'ACCOUNT', 'RESTAURANT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportCasePriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportCaseStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_RESTAURANT', 'WAITING_PROVIDER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportMessageAuthorType" AS ENUM ('CUSTOMER', 'RESTAURANT', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SupportMessageVisibility" AS ENUM ('INTERNAL', 'PUBLIC');

-- CreateTable
CREATE TABLE "support_cases" (
    "id" UUID NOT NULL,
    "case_number" TEXT NOT NULL,
    "customer_id" UUID,
    "restaurant_id" UUID,
    "order_id" UUID,
    "category" "SupportCaseCategory" NOT NULL,
    "priority" "SupportCasePriority" NOT NULL DEFAULT 'NORMAL',
    "status" "SupportCaseStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assigned_to_user_id" UUID,
    "resolved_at" TIMESTAMPTZ,
    "resolution_note" TEXT,
    "first_response_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "support_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "author_type" "SupportMessageAuthorType" NOT NULL,
    "author_id" UUID,
    "visibility" "SupportMessageVisibility" NOT NULL DEFAULT 'PUBLIC',
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "uploaded_by_type" TEXT NOT NULL,
    "uploaded_by_id" UUID,
    "object_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "session_id" TEXT,
    "customer_id" UUID,
    "restaurant_id" UUID,
    "order_id" UUID,
    "properties" JSONB,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_restaurant_metrics" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "orders_placed" INTEGER NOT NULL DEFAULT 0,
    "orders_completed" INTEGER NOT NULL DEFAULT 0,
    "orders_cancelled" INTEGER NOT NULL DEFAULT 0,
    "orders_rejected" INTEGER NOT NULL DEFAULT 0,
    "gross_order_value_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "refund_minor" BIGINT NOT NULL DEFAULT 0,
    "net_order_value_minor" BIGINT NOT NULL DEFAULT 0,
    "avg_order_value_minor" BIGINT NOT NULL DEFAULT 0,
    "avg_prep_seconds" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_restaurant_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_platform_metrics" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "orders_placed" INTEGER NOT NULL DEFAULT 0,
    "orders_completed" INTEGER NOT NULL DEFAULT 0,
    "orders_cancelled" INTEGER NOT NULL DEFAULT 0,
    "orders_rejected" INTEGER NOT NULL DEFAULT 0,
    "gross_order_value_minor" BIGINT NOT NULL DEFAULT 0,
    "discount_minor" BIGINT NOT NULL DEFAULT 0,
    "refund_minor" BIGINT NOT NULL DEFAULT 0,
    "net_order_value_minor" BIGINT NOT NULL DEFAULT 0,
    "avg_order_value_minor" BIGINT NOT NULL DEFAULT 0,
    "avg_prep_seconds" INTEGER NOT NULL DEFAULT 0,
    "payments_attempted" INTEGER NOT NULL DEFAULT 0,
    "payments_succeeded" INTEGER NOT NULL DEFAULT 0,
    "deliveries_attempted" INTEGER NOT NULL DEFAULT 0,
    "deliveries_succeeded" INTEGER NOT NULL DEFAULT 0,
    "support_cases_opened" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_platform_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_cases_case_number_key" ON "support_cases"("case_number");

-- CreateIndex
CREATE INDEX "support_cases_customer_id_created_at_idx" ON "support_cases"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_cases_restaurant_id_created_at_idx" ON "support_cases"("restaurant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_cases_status_created_at_idx" ON "support_cases"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "support_cases_assigned_to_user_id_status_idx" ON "support_cases"("assigned_to_user_id", "status");

-- CreateIndex
CREATE INDEX "support_messages_case_id_created_at_idx" ON "support_messages"("case_id", "created_at");

-- CreateIndex
CREATE INDEX "support_attachments_case_id_idx" ON "support_attachments"("case_id");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_events_idempotency_key_key" ON "analytics_events"("idempotency_key");

-- CreateIndex
CREATE INDEX "analytics_events_type_occurred_at_idx" ON "analytics_events"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_restaurant_id_occurred_at_idx" ON "analytics_events"("restaurant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_restaurant_metrics_restaurant_id_date_key" ON "daily_restaurant_metrics"("restaurant_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_platform_metrics_date_key" ON "daily_platform_metrics"("date");

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_cases" ADD CONSTRAINT "support_cases_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "support_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "support_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_restaurant_metrics" ADD CONSTRAINT "daily_restaurant_metrics_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

