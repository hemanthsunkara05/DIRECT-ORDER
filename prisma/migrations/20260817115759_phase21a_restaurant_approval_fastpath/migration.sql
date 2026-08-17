-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN     "decided_at" TIMESTAMPTZ,
ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMPTZ;
