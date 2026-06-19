-- Manually-logged field events from Discord (/quote, /visit, /onsite, /nobook,
-- /jobaccept, /followup). Additive + standalone — safe to apply on a live DB.

-- CreateEnum
CREATE TYPE "ManualEventType" AS ENUM ('QUOTE', 'VISIT', 'ONSITE', 'NOBOOK', 'JOBACCEPT', 'FOLLOWUP');

-- CreateTable
CREATE TABLE "manual_events" (
    "id" TEXT NOT NULL,
    "event_type" "ManualEventType" NOT NULL,
    "customer_name" TEXT,
    "zip" TEXT,
    "job_type" TEXT,
    "notes" TEXT,
    "logged_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "manual_events_event_type_idx" ON "manual_events"("event_type");

-- CreateIndex
CREATE INDEX "manual_events_zip_idx" ON "manual_events"("zip");

-- CreateIndex
CREATE INDEX "manual_events_created_at_idx" ON "manual_events"("created_at");
