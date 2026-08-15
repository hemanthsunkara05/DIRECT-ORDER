-- CreateIndex
CREATE INDEX "order_status_history_to_status_created_at_idx" ON "order_status_history"("to_status", "created_at");
