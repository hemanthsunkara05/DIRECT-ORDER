-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING_CREATION', 'CREATED', 'CREATION_FAILED', 'SEARCHING_COURIER', 'COURIER_ASSIGNED', 'AT_PICKUP', 'PICKED_UP', 'NO_COURIER_FOUND', 'DELIVERED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_delivery_id" TEXT,
    "status" "DeliveryStatus" NOT NULL,
    "pickup_address" JSONB NOT NULL,
    "dropoff_address" JSONB NOT NULL,
    "courier_name" TEXT,
    "courier_phone" TEXT,
    "tracking_url" TEXT,
    "quoted_fee_minor" BIGINT,
    "actual_fee_minor" BIGINT,
    "idempotency_key" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_pickup_at" TIMESTAMPTZ,
    "estimated_delivery_at" TIMESTAMPTZ,
    "picked_up_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "cancellation_reason" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_order_id_key" ON "deliveries"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_provider_provider_delivery_id_key" ON "deliveries"("provider", "provider_delivery_id");

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
