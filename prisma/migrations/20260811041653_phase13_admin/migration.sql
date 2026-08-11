-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPPORT', 'ADMIN_OPERATIONS', 'ADMIN_FINANCE', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "AdminRole" NOT NULL,
    "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_user_id_key" ON "admin_users"("user_id");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
