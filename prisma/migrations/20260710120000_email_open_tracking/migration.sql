-- Email open tracking (tracking-pixel) on notifications.
ALTER TABLE "notifications" ADD COLUMN "open_token" TEXT;
ALTER TABLE "notifications" ADD COLUMN "opened_at" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN "is_opened" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "notifications" ADD COLUMN "open_count" INTEGER NOT NULL DEFAULT 0;

-- Unique index so /api/email/open can look a notification up by its token.
CREATE UNIQUE INDEX "notifications_open_token_key" ON "notifications"("open_token");
