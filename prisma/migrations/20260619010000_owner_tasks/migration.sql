-- Owner task board (#owner-tasks): manually-created tasks for Diego & Sebastian,
-- ranked by importance (5 = highest), then due date, then due time.

-- CreateEnum
CREATE TYPE "TaskOwner" AS ENUM ('DIEGO', 'SEBASTIAN');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "importance" INTEGER NOT NULL DEFAULT 3,
    "owner" "TaskOwner" NOT NULL,
    "due_date" TIMESTAMP(3) NOT NULL,
    "due_time" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX "tasks_owner_idx" ON "tasks"("owner");

-- CreateIndex
CREATE INDEX "tasks_due_date_idx" ON "tasks"("due_date");
