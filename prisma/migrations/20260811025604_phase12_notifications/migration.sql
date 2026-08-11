-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'SMS', 'WHATSAPP', 'EMAIL', 'PUSH');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SECURITY', 'TRANSACTIONAL', 'ACCOUNT', 'MARKETING');

-- CreateEnum
CREATE TYPE "NotificationRecipientType" AS ENUM ('CUSTOMER', 'RESTAURANT_USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD_LETTERED', 'SUPPRESSED');

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "marketing_consent_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "recipient_type" "NotificationRecipientType" NOT NULL,
    "recipient_id" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contact_address" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "read_at" TIMESTAMPTZ,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "recipient_type" "NotificationRecipientType" NOT NULL,
    "recipient_id" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_recipient_type_recipient_id_created_at_idx" ON "notifications"("recipient_type", "recipient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_outbox_event_id_recipient_type_recipient_id_c_key" ON "notifications"("outbox_event_id", "recipient_type", "recipient_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_recipient_type_recipient_id_catego_key" ON "notification_preferences"("recipient_type", "recipient_id", "category", "channel");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
