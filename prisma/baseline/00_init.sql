-- ═══════════════════════════════════════════════════════════════════════════
--  BASELINE / INIT MIGRATION
--
--  Generated from the Prisma datamodel with:
--      prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma
--  then made IDEMPOTENT, and finally extended with the objects Prisma cannot
--  express (see the end of this file).
--
--  WHY IT EXISTS. Until this migration, nothing in prisma/migrations created a
--  base table. The schema had originally been made with `prisma db push`, and
--  every migration since assumed the tables were already there. The consequence
--  was invisible in day-to-day work and severe in a crisis: a database could
--  not be rebuilt from source control, so recovery depended entirely on
--  backups, and no fresh staging or CI environment could be created at all.
--
--  WHY IT IS GUARDED RATHER THAN "RESOLVED". The conventional fix is to
--  generate a baseline and then run `prisma migrate resolve --applied` against
--  production. That records a claim that the migration is already done. This
--  file instead RUNS on an existing database and does nothing, because every
--  statement is guarded. Nothing has to be taken on trust, and there is no
--  entry in `_prisma_migrations` that means something other than what happened.
--
--  ON AN EMPTY DATABASE it creates the full schema.
--  ON AN EXISTING DATABASE it is a no-op.
--  Both are verified in the release evidence.
--
--  ONE THING IT DOES NOT CREATE: the marketing tracker's separate `leads`
--  table. That table belongs to another system sharing this database and is not
--  in the Prisma datamodel. An environment rebuilt from this baseline will not
--  have it until the tracker's own schema is applied.
-- ═══════════════════════════════════════════════════════════════════════════

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MANAGER', 'CREW');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BookingStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PENDING_APPROVAL', 'CONFIRMED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "BookingState" AS ENUM ('PAYMENT_PENDING', 'PENDING_APPROVAL', 'APPROVED', 'CONFIRMED', 'RESCHEDULE_REQUESTED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DiscountType" AS ENUM ('FIRST_TIME_AUTO', 'DOOR_HANGER_PENDING', 'DOOR_HANGER_APPROVED', 'DOOR_HANGER_DENIED', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ServiceAreaZone" AS ENUM ('primary', 'extended_nj', 'new_york', 'manual_review', 'unsupported');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'SMS', 'DISCORD');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'DEFERRED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "JobStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "FileType" AS ENUM ('PHOTO_BEFORE', 'PHOTO_AFTER', 'PAPERWORK', 'RECEIPT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AuditAction" AS ENUM ('BOOKING_CREATED', 'BOOKING_STATE_CHANGED', 'BOOKING_DETAILS_UPDATED', 'PAYMENT_RECEIVED', 'PAYMENT_FAILED', 'PAYMENT_REFUNDED', 'PAYMENT_DISPUTED', 'DISCOUNT_APPLIED', 'DISCOUNT_APPROVED', 'DISCOUNT_DENIED', 'MOVE_SIZE_CHANGED', 'PRICE_CHANGE_APPROVED', 'INVENTORY_REVIEW_CLEARED', 'SERVICE_TYPE_CORRECTED', 'JOB_CREATED', 'JOB_STARTED', 'JOB_COMPLETED', 'FILE_UPLOADED', 'FILE_DELETED', 'RECEIPT_SENT', 'USER_LOGIN', 'USER_LOGOUT', 'SCHEDULE_MODIFIED', 'AVAILABILITY_SET', 'EXPENSE_CREATED', 'EXPENSE_UPDATED', 'EXPENSE_APPROVED', 'EXPENSE_REJECTED', 'EXPENSE_DELETED', 'OWNER_TRANSACTION_CREATED', 'OWNER_TRANSACTION_UPDATED', 'OWNER_TRANSACTION_DELETED', 'CREW_ASSIGNED', 'CREW_PAY_UPDATED', 'CREW_PAID', 'CREW_ASSIGNMENT_UPDATED', 'CREW_ASSIGNMENT_CANCELLED', 'CREW_ASSIGNMENT_ACCEPTED', 'CREW_ASSIGNMENT_DECLINED', 'CREW_CLOCK_IN', 'CREW_CLOCK_OUT', 'CREW_BREAK_UPDATED', 'CREW_HOURS_EDITED', 'CREW_HOURS_SUBMITTED', 'CREW_HOURS_APPROVED', 'CREW_HOURS_REJECTED', 'CREW_RATE_SNAPSHOT_CHANGED', 'CREW_PAYMENT_RECORDED', 'CREW_PAYMENT_VOIDED', 'CREW_ZERO_LABOR_CONFIRMED', 'CREW_OWNER_LABOR_VALUED', 'CLOSEOUT_STARTED', 'CLOSEOUT_SUBMITTED', 'CLOSEOUT_FINALIZED', 'CLOSEOUT_REOPENED', 'CLOSEOUT_OVERRIDE_USED', 'CLOSEOUT_REHEARSAL', 'LABOR_RATE_CONFIGURED', 'STAFF_INVITED', 'INVITATION_RESENT', 'INVITATION_CANCELLED', 'INVITATION_ACCEPTED', 'STAFF_DEACTIVATED', 'STAFF_REACTIVATED', 'STAFF_PROFILE_UPDATED', 'STAFF_SKILLS_CHANGED', 'STAFF_DRIVER_STATUS_CHANGED', 'AVAILABILITY_RULE_CREATED', 'AVAILABILITY_RULE_UPDATED', 'AVAILABILITY_RULE_DELETED', 'AVAILABILITY_EXCEPTION_CREATED', 'AVAILABILITY_EXCEPTION_DELETED', 'STAFFING_REQUIREMENT_CHANGED', 'ASSIGNMENT_OFFERED', 'ASSIGNMENT_ACKNOWLEDGED', 'ASSIGNMENT_DECLINED', 'ASSIGNMENT_REPLACED', 'ASSIGNMENT_DRIVER_CHANGED', 'ASSIGNMENT_LEAD_CHANGED', 'ASSIGNMENT_COMPLETED', 'ASSIGNMENT_NO_SHOW', 'CONFLICT_OVERRIDDEN', 'CLOSEOUT_TRUCK_SOURCE_CONFIRMED', 'CLOSEOUT_BALANCE_WRITTEN_OFF', 'CLOSEOUT_DISPUTE_ACKNOWLEDGED', 'OVERHEAD_METHOD_SELECTED', 'TAX_RESERVE_CHANGED', 'BUSINESS_RESERVE_CHANGED', 'OWNER_SPLIT_CHANGED', 'DISTRIBUTION_PLANNED', 'DISTRIBUTION_APPROVED', 'DISTRIBUTION_PAID', 'DISTRIBUTION_VOIDED', 'SNAPSHOT_SUPERSEDED', 'REPORT_EXPORTED', 'SAVED_VIEW_CREATED', 'SAVED_VIEW_DELETED', 'SAVED_VIEW_UPDATED', 'SAVED_VIEW_RENAMED', 'SAVED_VIEW_SHARED', 'SAVED_VIEW_UNSHARED', 'CAMPAIGN_CREATED', 'CAMPAIGN_UPDATED', 'CAMPAIGN_SPEND_RECORDED', 'ATTRIBUTION_CORRECTED', 'LEAD_CREATED', 'LEAD_STATUS_CHANGED', 'LEAD_QUOTE_CONFIRMATION_RESENT', 'PRICE_CHANGED', 'BUSINESS_CONFIG_UPDATED', 'REMINDER_UPDATED', 'ROADMAP_CREATED', 'ROADMAP_UPDATED', 'REMINDER_DISMISSED', 'REMINDER_RESTORED', 'FINANCIAL_ADJUSTMENT', 'WORKER_PAY_OVERRIDE', 'EMAIL_SCHEDULED_CANCELLED', 'EMAIL_SEND_RETRIED', 'EMAIL_SUPPRESSION_RESTORED', 'EMAIL_TEST_SENT', 'EMAIL_CAMPAIGN_CREATED', 'EMAIL_CAMPAIGN_UPDATED', 'EMAIL_CAMPAIGN_APPROVED', 'EMAIL_CAMPAIGN_STATE_CHANGED', 'EMAIL_AUDIENCE_SAVED', 'EMAIL_AUDIENCE_DELETED', 'EMAIL_JOURNEY_CONFIG_UPDATED', 'EMAIL_JOURNEY_CONFIG_RESET', 'EMAIL_AUTOMATION_SAVED', 'EMAIL_AUTOMATION_STATE_CHANGED', 'EMAIL_CAMPAIGN_DISPATCHED', 'EMAIL_CAMPAIGN_RUN_PAUSED', 'EMAIL_CAMPAIGN_RUN_RESUMED', 'EMAIL_CAMPAIGN_RUN_CANCELLED', 'EMAIL_CAMPAIGN_RETRY_INITIATED', 'EMAIL_LEAD_QUOTED', 'DEPOSIT_LINK_CREATED', 'DEPOSIT_LINK_CANCELED', 'DEPOSIT_LINK_PAID');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ScanStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ScanTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'API', 'PAGE_LOAD');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DismissalScope" AS ENUM ('OCCURRENCE', 'UNTIL_ENTITY_CHANGES', 'PERMANENT_RULE_ENTITY');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReminderSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReminderStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'SNOOZED', 'RESOLVED', 'DISMISSED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReminderCategory" AS ENUM ('BOOKING_DATA', 'JOBS_SCHEDULING', 'FINANCIAL', 'CUSTOMER_BALANCE', 'CREW_PAYROLL', 'LEADS', 'DATA_QUALITY');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RoadmapStatus" AS ENUM ('IDEA', 'RESEARCHING', 'PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'REJECTED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RoadmapPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "RoadmapCategory" AS ENUM ('FINANCIAL', 'REPORTS', 'JOBS', 'SCHEDULING', 'PAYROLL', 'LEADS', 'MARKETING', 'CUSTOMERS', 'PAYMENTS', 'EQUIPMENT', 'FLEET', 'DOCUMENTS', 'NOTIFICATIONS', 'SECURITY', 'AI', 'WEBSITE', 'BOOKING_FORM', 'SYSTEM', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ExpenseCategory" AS ENUM ('WORKER_PAY', 'GAS', 'TOLLS', 'PARKING', 'TRUCK_RENTAL', 'MOVING_EQUIPMENT', 'MOVING_BLANKETS', 'STRAPS_DOLLIES', 'ADVERTISING', 'WEBSITE_SOFTWARE', 'INSURANCE', 'PHONE', 'CREW_FOOD', 'REFUNDS', 'OFFICE', 'LEGAL_REGISTRATION', 'SUPPLIES', 'MISC');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ExpenseStatus" AS ENUM ('SUBMITTED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'REIMBURSED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'STRIPE', 'CARD', 'ZELLE', 'VENMO', 'CASHAPP', 'BANK_TRANSFER', 'CHECK', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "OwnerTransactionType" AS ENUM ('CONTRIBUTION', 'WITHDRAWAL', 'REIMBURSEMENT', 'DISTRIBUTION', 'PERSONAL_PURCHASE');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LeadSource" AS ENUM ('GOOGLE', 'FACEBOOK', 'INSTAGRAM', 'DOOR_HANGER', 'YARD_SIGN', 'REFERRAL', 'CRAIGSLIST', 'OFFERUP', 'RETURNING_CUSTOMER', 'WEBSITE', 'OTHER', 'HOMEPAGE_ESTIMATE', 'QUICK_QUOTE_FORM', 'BOOKING_FORM', 'SERVICES_PAGE', 'CONTACT_FORM', 'MOVING_CHECKLIST', 'GOOGLE_BUSINESS', 'FACEBOOK_MARKETPLACE', 'DOOR_HANGER_QR', 'YARD_SIGN_QR', 'CUSTOMER_REFERRAL', 'MANUAL_ENTRY', 'EXISTING_CUSTOMER_OPT_IN', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP', 'BOOKED', 'LOST');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LeadLostReason" AS ENUM ('PRICE_TOO_HIGH', 'NO_RESPONSE', 'DATE_UNAVAILABLE', 'CHOSE_COMPETITOR', 'NEEDED_IMMEDIATE', 'OUTSIDE_SERVICE_AREA', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LeadLifecycle" AS ENUM ('PARTIAL', 'IN_PROGRESS', 'SUBMITTED', 'CONVERTED', 'ABANDONED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CrewPayStatus" AS ENUM ('SCHEDULED', 'CHECKED_IN', 'WORKING', 'COMPLETED', 'PAY_APPROVED', 'PAID');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CrewWorkerType" AS ENUM ('OWNER', 'EMPLOYEE', 'CONTRACTOR', 'TEMP_HELPER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CrewRole" AS ENUM ('CREW_MEMBER', 'CREW_LEADER', 'DRIVER', 'HELPER', 'OWNER_OPERATOR', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CrewAssignmentStatus" AS ENUM ('INVITED', 'OFFERED', 'ACCEPTED', 'DECLINED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "WorkerStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ON_LEAVE', 'UNAVAILABLE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CrewSkill" AS ENUM ('PACKING', 'FURNITURE_PROTECTION', 'ASSEMBLY', 'HEAVY_ITEMS', 'STAIR_CARRY', 'DRIVING', 'LEAD', 'LOADING', 'UNLOADING');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AvailabilityExceptionKind" AS ENUM ('ADMIN_BLOCK', 'UNAVAILABLE_FULL', 'UNAVAILABLE_PARTIAL', 'AVAILABLE_OVERRIDE', 'VACATION', 'LEAVE');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TimeEntrySource" AS ENUM ('CLOCK', 'MANUAL', 'IMPORTED', 'OWNER_OVERRIDE', 'DISCORD_WORKFLOW');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LaborApprovalStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEEDS_REVIEW', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LaborPaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "LaborPayModel" AS ENUM ('HOURLY', 'FLAT', 'DAY_RATE', 'UNPAID_OWNER', 'ZERO_CONFIRMED', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CloseoutStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'MISSING_INFORMATION', 'READY_FOR_REVIEW', 'READY_TO_FINALIZE', 'FINALIZED', 'REOPENED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "OverheadMethod" AS ENUM ('NONE', 'PER_MOVE', 'PCT_REVENUE', 'PER_LABOR_HOUR', 'MONTHLY_POOL', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReserveKind" AS ENUM ('TAX', 'GENERAL', 'EMERGENCY', 'TRUCK_FUND', 'EQUIPMENT_FUND', 'LICENSING_FUND', 'INSURANCE_FUND', 'MARKETING_FUND', 'GROWTH_FUND', 'RETAINED_EARNINGS', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SplitMethod" AS ENUM ('EQUAL', 'OWNERSHIP_PERCENT', 'LABOR_FIRST', 'CUSTOM');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DistributionStatus" AS ENUM ('PLANNED', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TruckSource" AS ENUM ('CUSTOMER_PROVIDED', 'COMPANY_OWNED', 'RENTAL', 'THIRD_PARTY', 'NOT_REQUIRED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TravelPayPolicy" AS ENUM ('UNPAID', 'REGULAR', 'SEPARATE_RATE');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ManualEventType" AS ENUM ('QUOTE', 'VISIT', 'ONSITE', 'NOBOOK', 'JOBACCEPT', 'FOLLOWUP');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskOwner" AS ENUM ('DIEGO', 'SEBASTIAN');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED', 'VALIDATING', 'READY', 'SCHEDULED', 'CANCELLED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CampaignChannel" AS ENUM ('DOOR_HANGER', 'YARD_SIGN', 'QR_CODE', 'GOOGLE_ADS', 'META_ADS', 'GOOGLE_BUSINESS', 'MARKETPLACE', 'INSTAGRAM', 'EMAIL', 'REFERRAL_PROGRAM', 'PARTNERSHIP', 'WEBSITE', 'PHONE', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SpendKind" AS ENUM ('PRINT', 'DISTRIBUTION', 'AD_SPEND', 'PLATFORM_FEE', 'CREATIVE', 'ADJUSTMENT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ReportExportStatus" AS ENUM ('SUCCESS', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'INVALID_ADDRESS', 'ADMIN_BLOCK', 'PROVIDER_REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DepositRequestStatus" AS ENUM ('ACTIVE', 'PAID', 'EXPIRED', 'CANCELED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "DepositNotifyStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'SENDING', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CREW',
    "discord_id" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "pay_rate" INTEGER,
    "default_flat_rate_cents" INTEGER,
    "worker_type" "CrewWorkerType" NOT NULL DEFAULT 'EMPLOYEE',
    "preferred_role" TEXT,
    "emergency_contact" TEXT,
    "emergency_contact_phone" TEXT,
    "reliability_rating" INTEGER,
    "performance_notes" TEXT,
    "owner_economic_rate_cents" INTEGER,
    "default_pay_model" "LaborPayModel",
    "rate_effective_on" TIMESTAMP(3),
    "rate_notes" TEXT,
    "rate_updated_by_id" TEXT,
    "rate_updated_at" TIMESTAMP(3),
    "can_drive" BOOLEAN NOT NULL DEFAULT false,
    "can_lead_crew" BOOLEAN NOT NULL DEFAULT false,
    "worker_status" "WorkerStatus" NOT NULL DEFAULT 'ACTIVE',
    "skills" "CrewSkill"[] DEFAULT ARRAY[]::"CrewSkill"[],
    "license_expires_at" TIMESTAMP(3),
    "can_drive_customer_vehicle" BOOLEAN NOT NULL DEFAULT false,
    "start_date" TIMESTAMP(3),
    "deactivated_at" TIMESTAMP(3),
    "deactivation_reason" TEXT,
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "customers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "is_first_time" BOOLEAN NOT NULL DEFAULT true,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "marketing_opt_out" BOOLEAN NOT NULL DEFAULT false,
    "email_marketing_consent" BOOLEAN,
    "marketing_consent_at" TIMESTAMP(3),
    "marketing_consent_source" TEXT,
    "marketing_consent_version" TEXT,
    "preferred_name" TEXT,
    "secondary_phone" TEXT,
    "emergency_contact" TEXT,
    "emergency_contact_phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "bookings" (
    "id" TEXT NOT NULL,
    "display_id" TEXT NOT NULL,
    "booking_reference" TEXT,
    "status" "BookingStatus" NOT NULL DEFAULT 'DRAFT',
    "outbox_state" "BookingState",
    "is_internal_test" BOOLEAN NOT NULL DEFAULT false,
    "customer_id" TEXT NOT NULL,
    "origin_address" TEXT NOT NULL,
    "dest_address" TEXT NOT NULL,
    "origin_floor" INTEGER,
    "dest_floor" INTEGER,
    "has_elevator" BOOLEAN NOT NULL DEFAULT false,
    "items_description" TEXT,
    "estimated_hours" DOUBLE PRECISION,
    "requested_date" TIMESTAMP(3),
    "confirmed_date" TIMESTAMP(3),
    "scheduled_start" TIMESTAMP(3),
    "scheduled_end" TIMESTAMP(3),
    "previous_requested_date" TIMESTAMP(3),
    "reschedule_count" INTEGER NOT NULL DEFAULT 0,
    "rescheduled_at" TIMESTAMP(3),
    "deposit_amount" INTEGER NOT NULL DEFAULT 4900,
    "deposit_paid" BOOLEAN NOT NULL DEFAULT false,
    "truck_addon_due_on_move_day" BOOLEAN NOT NULL DEFAULT false,
    "truck_addon_amount" INTEGER NOT NULL DEFAULT 0,
    "base_rate" DOUBLE PRECISION,
    "total_estimate" DOUBLE PRECISION,
    "final_amount" DOUBLE PRECISION,
    "service_area_zone" "ServiceAreaZone",
    "travel_fee" INTEGER NOT NULL DEFAULT 0,
    "travel_fee_due_on_move_day" BOOLEAN NOT NULL DEFAULT false,
    "manual_review_required" BOOLEAN NOT NULL DEFAULT false,
    "review_reasons" TEXT[],
    "service_area_message" TEXT,
    "distance_from_west_orange_miles" DOUBLE PRECISION,
    "estimated_drive_time_minutes" INTEGER,
    "address_evaluation" JSONB,
    "discount_code" TEXT,
    "discount_type" "DiscountType",
    "discount_percent" DOUBLE PRECISION,
    "discount_approved_by_id" TEXT,
    "stripe_checkout_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "discord_job_channel_id" TEXT,
    "discord_paperwork_channel_id" TEXT,
    "discord_photos_channel_id" TEXT,
    "discord_approval_message_id" TEXT,
    "customer_token" TEXT NOT NULL,
    "customer_token_expiry" TIMESTAMP(3) NOT NULL,
    "internal_notes" TEXT,
    "customer_notes" TEXT,
    "origin_unit" TEXT,
    "dest_unit" TEXT,
    "origin_has_elevator" BOOLEAN,
    "dest_has_elevator" BOOLEAN,
    "origin_stair_count" INTEGER,
    "dest_stair_count" INTEGER,
    "origin_access_notes" TEXT,
    "dest_access_notes" TEXT,
    "origin_access_code" TEXT,
    "dest_access_code" TEXT,
    "truck_provider" TEXT,
    "truck_size" TEXT,
    "truck_reservation_status" TEXT,
    "truck_pickup_location" TEXT,
    "truck_return_responsibility" TEXT,
    "equipment_needs" TEXT,
    "crew_instructions" TEXT,
    "difficult_elevator_pickup" BOOLEAN,
    "difficult_elevator_dropoff" BOOLEAN,
    "difficult_building_pickup" BOOLEAN,
    "difficult_building_dropoff" BOOLEAN,
    "inventory_accuracy_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "origin_street_number" TEXT,
    "origin_route" TEXT,
    "origin_city" TEXT,
    "origin_county" TEXT,
    "origin_state" TEXT,
    "origin_zip" TEXT,
    "origin_country" TEXT,
    "origin_formatted_address" TEXT,
    "origin_lat" DOUBLE PRECISION,
    "origin_lng" DOUBLE PRECISION,
    "origin_place_id" TEXT,
    "origin_verification_status" TEXT,
    "origin_validation_reason" TEXT,
    "dest_street_number" TEXT,
    "dest_route" TEXT,
    "dest_city" TEXT,
    "dest_county" TEXT,
    "dest_state" TEXT,
    "dest_zip" TEXT,
    "dest_country" TEXT,
    "dest_formatted_address" TEXT,
    "dest_lat" DOUBLE PRECISION,
    "dest_lng" DOUBLE PRECISION,
    "dest_place_id" TEXT,
    "dest_verification_status" TEXT,
    "dest_validation_reason" TEXT,
    "bedrooms" INTEGER,
    "estimated_cubic_feet" INTEGER,
    "estimated_weight_lbs" INTEGER,
    "num_boxes" INTEGER,
    "needs_packing" BOOLEAN,
    "needs_unpacking" BOOLEAN,
    "needs_assembly" BOOLEAN,
    "needs_disassembly" BOOLEAN,
    "needs_storage" BOOLEAN,
    "has_piano" BOOLEAN,
    "has_safe" BOOLEAN,
    "has_pool_table" BOOLEAN,
    "has_appliances" BOOLEAN,
    "specialty_items" TEXT,
    "service_type_key" TEXT,
    "move_size_key" TEXT,
    "labor_service" TEXT,
    "labor_requested_minutes" INTEGER,
    "labor_billable_minutes" INTEGER,
    "labor_minimum_applied" BOOLEAN,
    "labor_rate_cents" INTEGER,
    "labor_workers" INTEGER,
    "labor_subtotal_cents" INTEGER,
    "routed_miles" DOUBLE PRECISION,
    "billable_miles" INTEGER,
    "mileage_rate_cents" INTEGER,
    "transportation_charge" INTEGER,
    "route_status" TEXT,
    "route_manual_review" BOOLEAN NOT NULL DEFAULT false,
    "route_summary" JSONB,
    "move_size_changed_at" TIMESTAMP(3),
    "move_size_changed_by_id" TEXT,
    "move_size_change_reason" TEXT,
    "inventory_detail" JSONB,
    "inventory_suggested_size" TEXT,
    "inventory_review_required" BOOLEAN NOT NULL DEFAULT false,
    "assembly_items" TEXT,
    "disassembly_items" TEXT,
    "assembly_scope_known" BOOLEAN,
    "assembly_approval_required" BOOLEAN NOT NULL DEFAULT false,
    "coi_required_origin" TEXT,
    "coi_required_dest" TEXT,
    "coi_notes" TEXT,
    "photos_review_required" BOOLEAN NOT NULL DEFAULT false,
    "discount_rejected" JSONB,
    "price_change_approved_at" TIMESTAMP(3),
    "price_change_approved_by_id" TEXT,
    "truck_reservation_number" TEXT,
    "truck_pickup_time" TEXT,
    "truck_return_address" TEXT,
    "driver_name" TEXT,
    "driver_phone" TEXT,
    "driver_license" TEXT,
    "truck_fuel_policy" TEXT,
    "additional_truck_fees" INTEGER,
    "stair_fee" INTEGER,
    "long_carry_fee" INTEGER,
    "heavy_item_fee" INTEGER,
    "packing_fee" INTEGER,
    "assembly_fee" INTEGER,
    "disassembly_fee" INTEGER,
    "tax_amount" INTEGER,
    "processing_fee" INTEGER,
    "crew_arrived_at" TIMESTAMP(3),
    "customer_ready_at" TIMESTAMP(3),
    "waiting_started_at" TIMESTAMP(3),
    "waiting_ended_at" TIMESTAMP(3),
    "waiting_minutes" INTEGER,
    "waiting_fee" INTEGER,
    "waiting_fee_override" INTEGER,
    "waiting_fee_waived" BOOLEAN NOT NULL DEFAULT false,
    "waiting_waiver_reason" TEXT,
    "waiting_fee_collected" BOOLEAN NOT NULL DEFAULT false,
    "arrival_window" TEXT,
    "assigned_dispatcher" TEXT,
    "dispatcher_notes" TEXT,
    "crew_notes" TEXT,
    "driver_notes" TEXT,
    "office_notes" TEXT,
    "scheduling_notes" TEXT,
    "travel_notes" TEXT,
    "problem_flags" TEXT,
    "outstanding_tasks" TEXT,
    "completion_progress" INTEGER,
    "agreement_accepted" BOOLEAN NOT NULL DEFAULT false,
    "agreement_version" TEXT,
    "agreement_accepted_at" TIMESTAMP(3),
    "agreement_name" TEXT,
    "agreement_signature" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "referrer" TEXT,
    "source" TEXT,
    "found_us" TEXT,
    "first_touch_source" TEXT,
    "first_touch_campaign" TEXT,
    "first_touch_at" TIMESTAMP(3),
    "last_touch_source" TEXT,
    "last_touch_campaign" TEXT,
    "booking_source" TEXT,
    "booking_campaign" TEXT,
    "owner_assigned_source" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "qr_campaign" TEXT,
    "attribution_id" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "lead_notifications" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_jobs" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "payments" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "stripe_payment_intent_id" TEXT,
    "stripe_charge_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "method" "PaymentMethod",
    "is_internal_test" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "receipt_url" TEXT,
    "metadata" JSONB,
    "refunded_amount_cents" INTEGER,
    "stripe_refund_id" TEXT,
    "stripe_dispute_id" TEXT,
    "dispute_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "jobs" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'SCHEDULED',
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "duration_mins" INTEGER,
    "crew_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "job_crew" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "crew_leader" BOOLEAN NOT NULL DEFAULT false,
    "scheduled_hours" DOUBLE PRECISION,
    "actual_hours" DOUBLE PRECISION,
    "clock_in" TIMESTAMP(3),
    "clock_out" TIMESTAMP(3),
    "break_minutes" INTEGER,
    "pay_rate" INTEGER,
    "flat_pay" INTEGER,
    "tips" INTEGER,
    "bonus" INTEGER,
    "deductions" INTEGER,
    "pay_method" "PaymentMethod",
    "pay_status" "CrewPayStatus" NOT NULL DEFAULT 'SCHEDULED',
    "paid_at" TIMESTAMP(3),
    "pay_notes" TEXT,
    "worker_type" "CrewWorkerType" NOT NULL DEFAULT 'EMPLOYEE',
    "role" "CrewRole" NOT NULL DEFAULT 'CREW_MEMBER',
    "assignment_status" "CrewAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "crew_job_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "assignment_notes" TEXT,
    "offered_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "acknowledgment_stale_at" TIMESTAMP(3),
    "decline_reason" TEXT,
    "removed_at" TIMESTAMP(3),
    "removal_reason" TEXT,
    "completed_at" TIMESTAMP(3),
    "no_show_at" TIMESTAMP(3),
    "report_time" TIMESTAMP(3),
    "is_driver" BOOLEAN NOT NULL DEFAULT false,
    "worker_visible_notes" TEXT,
    "private_admin_notes" TEXT,
    "scheduled_start_at" TIMESTAMP(3),
    "scheduled_end_at" TIMESTAMP(3),
    "scheduled_break_minutes" INTEGER,
    "scheduled_minutes" INTEGER,
    "scheduled_travel_minutes" INTEGER,
    "break_started_at" TIMESTAMP(3),
    "actual_break_minutes" INTEGER,
    "worked_minutes" INTEGER,
    "regular_minutes" INTEGER,
    "overtime_minutes" INTEGER,
    "travel_minutes" INTEGER,
    "paid_minutes" INTEGER,
    "time_entry_source" "TimeEntrySource",
    "time_adjusted_by_id" TEXT,
    "time_adjusted_at" TIMESTAMP(3),
    "time_adjust_reason" TEXT,
    "pay_model" "LaborPayModel" NOT NULL DEFAULT 'HOURLY',
    "hourly_rate_cents_snapshot" INTEGER,
    "overtime_rate_cents_snapshot" INTEGER,
    "flat_pay_cents_snapshot" INTEGER,
    "day_rate_cents_snapshot" INTEGER,
    "travel_pay_policy" "TravelPayPolicy" NOT NULL DEFAULT 'REGULAR',
    "travel_rate_cents_snapshot" INTEGER,
    "economic_rate_cents_snapshot" INTEGER,
    "rate_snapshot_at" TIMESTAMP(3),
    "rate_snapshot_source" TEXT,
    "rate_adjusted_by_id" TEXT,
    "rate_adjusted_at" TIMESTAMP(3),
    "rate_adjust_reason" TEXT,
    "driver_bonus_cents_snapshot" INTEGER,
    "crew_leader_bonus_cents_snapshot" INTEGER,
    "other_bonus_cents" INTEGER,
    "other_bonus_reason" TEXT,
    "reimbursement_cents" INTEGER,
    "reimbursement_reason" TEXT,
    "calculated_pay_cents" INTEGER,
    "approved_pay_cents" INTEGER,
    "approval_status" "LaborApprovalStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMP(3),
    "submitted_by_id" TEXT,
    "approved_by_id" TEXT,
    "approved_at" TIMESTAMP(3),
    "rejected_reason" TEXT,
    "adjustment_reason" TEXT,
    "zero_labor_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "zero_labor_confirmed_by_id" TEXT,
    "zero_labor_confirmed_at" TIMESTAMP(3),
    "zero_labor_confirmed_reason" TEXT,
    "payment_status" "LaborPaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "updated_by_id" TEXT,
    "source_system" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_crew_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "labor_payments" (
    "id" TEXT NOT NULL,
    "job_crew_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paid_on" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "proof_url" TEXT,
    "proof_public_id" TEXT,
    "recorded_by_id" TEXT,
    "recorded_by_name" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_by_id" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labor_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "availability" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "is_day_off" BOOLEAN NOT NULL DEFAULT false,
    "start_time" TEXT,
    "end_time" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "day_blocks" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT true,
    "blocked_by" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "availability_rules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "effective_from" DATE,
    "effective_to" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "availability_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "availability_exceptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" "AvailabilityExceptionKind" NOT NULL,
    "date" DATE NOT NULL,
    "start_minute" INTEGER,
    "end_minute" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "reason" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "job_staffing_requirements" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "min_workers" INTEGER NOT NULL DEFAULT 1,
    "required_workers" INTEGER NOT NULL DEFAULT 2,
    "preferred_workers" INTEGER,
    "required_drivers" INTEGER NOT NULL DEFAULT 1,
    "requires_lead" BOOLEAN NOT NULL DEFAULT true,
    "required_skills" "CrewSkill"[] DEFAULT ARRAY[]::"CrewSkill"[],
    "estimated_start_at" TIMESTAMP(3),
    "estimated_end_at" TIMESTAMP(3),
    "report_time" TIMESTAMP(3),
    "expected_break_minutes" INTEGER,
    "additional_stops" INTEGER NOT NULL DEFAULT 0,
    "has_stairs" BOOLEAN NOT NULL DEFAULT false,
    "has_elevator" BOOLEAN NOT NULL DEFAULT false,
    "long_carry" BOOLEAN NOT NULL DEFAULT false,
    "heavy_items" BOOLEAN NOT NULL DEFAULT false,
    "packing" BOOLEAN NOT NULL DEFAULT false,
    "assembly" BOOLEAN NOT NULL DEFAULT false,
    "customer_provided_truck" BOOLEAN NOT NULL DEFAULT false,
    "rental_truck_pickup" BOOLEAN NOT NULL DEFAULT false,
    "driving_required" BOOLEAN NOT NULL DEFAULT true,
    "out_of_state" BOOLEAN NOT NULL DEFAULT false,
    "loading_location" TEXT,
    "unloading_location" TEXT,
    "worker_instructions" TEXT,
    "private_notes" TEXT,
    "created_by_id" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_staffing_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "crew_invitations" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'CREW',
    "worker_type" "CrewWorkerType" NOT NULL DEFAULT 'EMPLOYEE',
    "initial_rate_cents" INTEGER,
    "initial_skills" "CrewSkill"[] DEFAULT ARRAY[]::"CrewSkill"[],
    "can_drive" BOOLEAN NOT NULL DEFAULT false,
    "token" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_id" TEXT NOT NULL,
    "accepted_by_user_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_id" TEXT,
    "resent_at" TIMESTAMP(3),
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "conflict_overrides" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "job_crew_id" TEXT,
    "user_id" TEXT,
    "code" TEXT NOT NULL,
    "details" JSONB,
    "reason" TEXT NOT NULL,
    "overridden_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflict_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "assignment_notifications" (
    "id" TEXT NOT NULL,
    "job_crew_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "provider_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "files" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT,
    "job_id" TEXT,
    "type" "FileType" NOT NULL,
    "cloudinary_id" TEXT NOT NULL,
    "cloudinary_url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "receipts" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "cloudinary_id" TEXT,
    "cloudinary_url" TEXT,
    "sent_at" TIMESTAMP(3),
    "sent_to" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "template" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "bull_job_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "open_token" TEXT,
    "opened_at" TIMESTAMP(3),
    "is_opened" BOOLEAN NOT NULL DEFAULT false,
    "open_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "webhook_logs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "user_id" TEXT,
    "booking_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "result" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "manual_events" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "tasks" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "followup_ledger" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'both',
    "status" TEXT NOT NULL DEFAULT 'planned',
    "error" TEXT,
    "email_status" TEXT,
    "sms_status" TEXT,
    "email_attempts" INTEGER NOT NULL DEFAULT 0,
    "sms_attempts" INTEGER NOT NULL DEFAULT 0,
    "email_provider_id" TEXT,
    "sms_provider_id" TEXT,
    "email_last_error" TEXT,
    "sms_last_error" TEXT,
    "next_attempt_at" TIMESTAMP(3),
    "terminal_reason" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followup_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "reviews" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "is_positive" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'admin',
    "comment" TEXT,
    "left_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "expenses" (
    "id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "incurred_on" TIMESTAMP(3) NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "vendor" TEXT,
    "payment_method" "PaymentMethod",
    "paid_by" TEXT,
    "booking_id" TEXT,
    "purpose" TEXT,
    "receipt_url" TEXT,
    "receipt_public_id" TEXT,
    "reimbursable" BOOLEAN NOT NULL DEFAULT false,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'SUBMITTED',
    "notes" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "owner_transactions" (
    "id" TEXT NOT NULL,
    "owner" "TaskOwner" NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" "OwnerTransactionType" NOT NULL,
    "occurred_on" TIMESTAMP(3) NOT NULL,
    "payment_method" "PaymentMethod",
    "explanation" TEXT,
    "receipt_url" TEXT,
    "receipt_public_id" TEXT,
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "booking_id" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "crm_leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'OTHER',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "lost_reason" "LeadLostReason",
    "estimated_value" INTEGER,
    "job_type" TEXT,
    "move_date" TIMESTAMP(3),
    "zip" TEXT,
    "origin_zip" TEXT,
    "destination_zip" TEXT,
    "move_size" TEXT,
    "notes" TEXT,
    "assigned_to" TEXT,
    "converted_booking_id" TEXT,
    "message" TEXT,
    "origin_city" TEXT,
    "dest_city" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "utm_term" TEXT,
    "landing_page" TEXT,
    "referrer" TEXT,
    "promo_code" TEXT,
    "attribution_id" TEXT,
    "last_activity_at" TIMESTAMP(3),
    "booking_session_id" TEXT,
    "form_step" TEXT,
    "lifecycle" "LeadLifecycle",
    "email_marketing_consent" BOOLEAN,
    "marketing_consent_at" TIMESTAMP(3),
    "marketing_consent_source" TEXT,
    "marketing_consent_version" TEXT,
    "marketing_consent_prompted" BOOLEAN,
    "found_us" TEXT,
    "found_us_prompted" BOOLEAN,
    "pickup_address_complete" BOOLEAN,
    "destination_address_complete" BOOLEAN,
    "contact_preference" TEXT,
    "best_time_to_call" TEXT,
    "quote_confirmation_queued_at" TIMESTAMP(3),
    "quote_confirmation_status" TEXT,
    "quote_confirmation_delivered_at" TIMESTAMP(3),
    "quote_confirmation_failed_at" TIMESTAMP(3),
    "quote_confirmation_last_error" TEXT,
    "quote_base_cents" INTEGER,
    "quote_truck_cents" INTEGER,
    "quote_total_cents" INTEGER,
    "quote_included_truck" TEXT,
    "quote_mileage_status" TEXT,
    "quote_price_book_version" TEXT,
    "quote_mileage_cents" INTEGER,
    "quote_billable_miles" INTEGER,
    "quote_requires_review" BOOLEAN,
    "quote_review_reasons" TEXT,
    "quote_confirmation_count" INTEGER NOT NULL DEFAULT 0,
    "alert_fingerprint" TEXT,
    "last_alerted_at" TIMESTAMP(3),
    "alert_status" TEXT,
    "alert_delivered_at" TIMESTAMP(3),
    "contacted_at" TIMESTAMP(3),
    "quoted_at" TIMESTAMP(3),
    "booked_at" TIMESTAMP(3),
    "lost_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "reminders" (
    "id" TEXT NOT NULL,
    "reminder_type" TEXT NOT NULL,
    "category" "ReminderCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "ReminderSeverity" NOT NULL,
    "status" "ReminderStatus" NOT NULL DEFAULT 'OPEN',
    "source_entity_type" TEXT,
    "source_entity_id" TEXT,
    "source_url" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "due_at" TIMESTAMP(3),
    "snoozed_until" TIMESTAMP(3),
    "assigned_owner" "TaskOwner",
    "created_by" TEXT NOT NULL DEFAULT 'system',
    "internal_note" TEXT,
    "resolution_note" TEXT,
    "metadata" JSONB,
    "acknowledged_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "assigned_at" TIMESTAMP(3),
    "assigned_by_name" TEXT,
    "claimed_by_id" TEXT,
    "claimed_by_name" TEXT,
    "claimed_at" TIMESTAMP(3),
    "completed_by_id" TEXT,
    "completed_by_name" TEXT,
    "dismissal_scope" "DismissalScope",
    "dismissed_by_id" TEXT,
    "dismissed_by_name" TEXT,
    "entity_fingerprint" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "scan_runs" (
    "id" TEXT NOT NULL,
    "status" "ScanStatus" NOT NULL DEFAULT 'RUNNING',
    "trigger" "ScanTrigger" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "triggered_by_id" TEXT,
    "triggered_by_name" TEXT,
    "rules_evaluated" INTEGER,
    "entities_evaluated" INTEGER,
    "reminders_created" INTEGER,
    "reminders_updated" INTEGER,
    "reminders_reopened" INTEGER,
    "reminders_resolved" INTEGER,
    "reminders_skipped" INTEGER,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "error_summary" TEXT,
    "worker" TEXT,

    CONSTRAINT "scan_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "roadmap_items" (
    "id" TEXT NOT NULL,
    "seed_key" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "problem" TEXT,
    "solution" TEXT,
    "benefit" TEXT,
    "risks" TEXT,
    "priority" "RoadmapPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "RoadmapStatus" NOT NULL DEFAULT 'IDEA',
    "category" "RoadmapCategory" NOT NULL DEFAULT 'OTHER',
    "impact" INTEGER,
    "effort" INTEGER,
    "dependencies" TEXT,
    "blockers" TEXT,
    "assigned_owner" "TaskOwner",
    "target_increment" TEXT,
    "notes" TEXT,
    "comments" JSONB,
    "rejection_reason" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "business_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "diego_split_percent" INTEGER NOT NULL DEFAULT 50,
    "sebastian_split_percent" INTEGER NOT NULL DEFAULT 50,
    "tax_reserve_percent" INTEGER NOT NULL DEFAULT 25,
    "emergency_reserve_cents" INTEGER NOT NULL DEFAULT 0,
    "owner_economic_rate_cents" INTEGER NOT NULL DEFAULT 3000,
    "overtime_threshold_minutes" INTEGER NOT NULL DEFAULT 480,
    "overtime_multiplier_pct" INTEGER NOT NULL DEFAULT 150,
    "long_shift_review_minutes" INTEGER NOT NULL DEFAULT 840,
    "overhead_method" "OverheadMethod" NOT NULL DEFAULT 'NONE',
    "overhead_per_move_cents" INTEGER NOT NULL DEFAULT 0,
    "overhead_pct_revenue_bp" INTEGER NOT NULL DEFAULT 0,
    "overhead_per_labor_hour_cents" INTEGER NOT NULL DEFAULT 0,
    "overhead_monthly_pool_cents" INTEGER NOT NULL DEFAULT 0,
    "receipt_required_above_cents" INTEGER NOT NULL DEFAULT 2500,
    "general_reserve_bp" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "move_closeouts" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "status" "CloseoutStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "started_at" TIMESTAMP(3),
    "started_by_id" TEXT,
    "submitted_at" TIMESTAMP(3),
    "submitted_by_id" TEXT,
    "finalized_at" TIMESTAMP(3),
    "finalized_by_id" TEXT,
    "reopened_at" TIMESTAMP(3),
    "reopened_by_id" TEXT,
    "reopen_reason" TEXT,
    "overrides" JSONB,
    "notes" TEXT,
    "truck_source" "TruckSource",
    "truck_source_confirmed_at" TIMESTAMP(3),
    "truck_source_confirmed_by_id" TEXT,
    "balance_write_off_cents" INTEGER,
    "balance_write_off_reason" TEXT,
    "dispute_acknowledged_at" TIMESTAMP(3),
    "overhead_method" "OverheadMethod",
    "overhead_amount_cents" INTEGER,
    "overhead_reason" TEXT,
    "tax_reserve_bp" INTEGER,
    "tax_reserve_cents" INTEGER,
    "tax_reserve_reason" TEXT,
    "business_retained_bp" INTEGER,
    "split_method" "SplitMethod",
    "split_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "move_closeouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "financial_snapshots" (
    "id" TEXT NOT NULL,
    "closeout_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "net_billed_revenue_cents" INTEGER NOT NULL,
    "net_collected_revenue_cents" INTEGER NOT NULL,
    "outstanding_balance_cents" INTEGER NOT NULL,
    "refunded_cents" INTEGER NOT NULL,
    "chargeback_cents" INTEGER NOT NULL,
    "disputed_open_cents" INTEGER NOT NULL,
    "direct_expense_cents" INTEGER NOT NULL,
    "crew_labor_cents" INTEGER NOT NULL,
    "owner_cash_labor_cents" INTEGER NOT NULL,
    "owner_economic_labor_cents" INTEGER NOT NULL,
    "processing_fee_cents" INTEGER NOT NULL,
    "truck_cost_cents" INTEGER NOT NULL,
    "direct_job_cost_cents" INTEGER NOT NULL,
    "cash_gross_profit_cents" INTEGER NOT NULL,
    "economic_profit_cents" INTEGER NOT NULL,
    "allocated_overhead_cents" INTEGER NOT NULL,
    "company_net_profit_cents" INTEGER NOT NULL,
    "economic_net_profit_cents" INTEGER NOT NULL,
    "margin_bp" INTEGER,
    "tax_reserve_cents" INTEGER NOT NULL,
    "business_retained_bp" INTEGER NOT NULL DEFAULT 0,
    "business_retained_cents" INTEGER NOT NULL DEFAULT 0,
    "rounding_remainder_cents" INTEGER NOT NULL DEFAULT 0,
    "business_reserve_cents" INTEGER NOT NULL,
    "retained_earnings_cents" INTEGER NOT NULL,
    "unresolved_liability_cents" INTEGER NOT NULL,
    "distributable_profit_cents" INTEGER NOT NULL,
    "owner_allocations" JSONB,
    "allocation_lines" JSONB,
    "overhead_method" "OverheadMethod" NOT NULL,
    "overhead_rate_raw" INTEGER,
    "tax_reserve_bp" INTEGER,
    "split_method" "SplitMethod",
    "incomplete_flags" JSONB,
    "calculation_version" TEXT NOT NULL,
    "config_source" TEXT,
    "config_version" TEXT,
    "superseded_at" TIMESTAMP(3),
    "superseded_by_id" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "reserve_allocations" (
    "id" TEXT NOT NULL,
    "closeout_id" TEXT,
    "booking_id" TEXT,
    "kind" "ReserveKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "reason" TEXT,
    "transferred" BOOLEAN NOT NULL DEFAULT false,
    "transferred_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reserve_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "owner_distributions" (
    "id" TEXT NOT NULL,
    "owner" "TaskOwner" NOT NULL,
    "booking_id" TEXT,
    "snapshot_id" TEXT,
    "status" "DistributionStatus" NOT NULL DEFAULT 'PLANNED',
    "approved_cents" INTEGER NOT NULL,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "percent_bp" INTEGER,
    "method" "PaymentMethod",
    "paid_on" TIMESTAMP(3),
    "reference" TEXT,
    "notes" TEXT,
    "approved_by_id" TEXT,
    "approved_by_name" TEXT,
    "approved_at" TIMESTAMP(3),
    "recorded_by_id" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "voided_by_id" TEXT,
    "voided_at" TIMESTAMP(3),
    "void_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_distributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "marketing_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "CampaignChannel" NOT NULL,
    "source_key" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "budget_cents" INTEGER,
    "print_quantity" INTEGER,
    "distribution_area" TEXT,
    "creative_version" TEXT,
    "offer" TEXT,
    "landing_page_url" TEXT,
    "qr_identifier" TEXT,
    "phone_identifier" TEXT,
    "notes" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "marketing_spend" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "kind" "SpendKind" NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "incurred_on" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "receipt_url" TEXT,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_spend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "saved_report_views" (
    "id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "sort_key" TEXT,
    "sort_dir" TEXT,
    "columns" TEXT[],
    "period_key" TEXT,
    "scope" TEXT,
    "basis" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" TEXT NOT NULL,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_report_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "report_exports" (
    "id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "period_label" TEXT NOT NULL,
    "basis_label" TEXT NOT NULL,
    "filters" JSONB,
    "column_keys" TEXT[],
    "record_count" INTEGER NOT NULL,
    "status" "ReportExportStatus" NOT NULL DEFAULT 'SUCCESS',
    "error" TEXT,
    "requested_by_id" TEXT NOT NULL,
    "requested_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_suppressions" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "source" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_sends" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "email_class" TEXT NOT NULL,
    "journey" TEXT,
    "booking_id" TEXT,
    "lead_id" TEXT,
    "campaign" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sending',
    "outcome_class" TEXT,
    "blocked_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "provider_id" TEXT,
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "bounced_at" TIMESTAMP(3),
    "complained_at" TIMESTAMP(3),
    "delivery_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "campaign_id" TEXT,
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "journey_config_version" INTEGER,

    CONSTRAINT "email_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_events" (
    "id" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "email_send_id" TEXT,
    "email" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "processing_status" TEXT NOT NULL DEFAULT 'processed',
    "side_effect_attempts" INTEGER NOT NULL DEFAULT 0,
    "side_effect_error" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_audiences" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "last_preview_count" INTEGER,
    "last_preview_at" TIMESTAMP(3),
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_campaign_configs" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "subject" TEXT,
    "audience_id" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "approved_by_id" TEXT,
    "approved_by_name" TEXT,
    "approved_at" TIMESTAMP(3),
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_content" TEXT,
    "discount_code" TEXT,
    "validation" JSONB,
    "approved_config_hash" TEXT,
    "status_note" TEXT,
    "dispatched_at" TIMESTAMP(3),
    "dispatched_count" INTEGER,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaign_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_journey_configs" (
    "id" TEXT NOT NULL,
    "journey_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "config" JSONB NOT NULL,
    "updated_by_id" TEXT,
    "updated_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_journey_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_automations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "active_version" INTEGER,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_automation_versions" (
    "id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_automation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_campaign_runs" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "snapshot" JSONB NOT NULL,
    "preflight" JSONB,
    "total_recipients" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "cancelled_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_by_id" TEXT,
    "started_by_name" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaign_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_campaign_recipients" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "customer_id" TEXT,
    "lead_id" TEXT,
    "booking_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "batch_index" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "email_send_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_automation_enrollments" (
    "id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "booking_id" TEXT,
    "lead_id" TEXT,
    "customer_id" TEXT,
    "email" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "trigger_snapshot" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stop_reason" TEXT,
    "current_stage" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3),
    "history" JSONB,
    "last_evaluated_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "error" TEXT,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_automation_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" TEXT NOT NULL DEFAULT 'read_only',
    "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auto_actions_enabled" BOOLEAN NOT NULL DEFAULT true,
    "alerts_enabled" BOOLEAN NOT NULL DEFAULT true,
    "digest_warnings" BOOLEAN NOT NULL DEFAULT true,
    "marketing_dispatch_paused" BOOLEAN NOT NULL DEFAULT false,
    "paused_reason" TEXT,
    "paused_at" TIMESTAMP(3),
    "paused_by" TEXT,
    "max_auto_actions_per_run" INTEGER NOT NULL DEFAULT 3,
    "stage_recipient_limit" INTEGER NOT NULL DEFAULT 50,
    "interval_minutes" INTEGER NOT NULL DEFAULT 5,
    "memory_retention_days" INTEGER NOT NULL DEFAULT 365,
    "max_model_calls_per_cycle" INTEGER NOT NULL DEFAULT 2,
    "max_model_calls_per_day" INTEGER NOT NULL DEFAULT 25,
    "max_tokens_per_day" INTEGER NOT NULL DEFAULT 150000,
    "max_tokens_per_month" INTEGER NOT NULL DEFAULT 3000000,
    "max_ai_cost_usd_per_day" DOUBLE PRECISION NOT NULL DEFAULT 0.20,
    "max_ai_cost_usd_per_month" DOUBLE PRECISION NOT NULL DEFAULT 3.00,
    "ai_reinvestigate_hours" INTEGER NOT NULL DEFAULT 12,
    "fallback_provider" TEXT,
    "fallback_model" TEXT,
    "allow_provider_fallback" BOOLEAN NOT NULL DEFAULT true,
    "max_auto_actions_per_day" INTEGER NOT NULL DEFAULT 10,
    "max_auto_actions_per_tool_day" INTEGER NOT NULL DEFAULT 4,
    "max_auto_actions_per_incident" INTEGER NOT NULL DEFAULT 3,
    "resource_action_cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
    "auto_failure_downgrade_threshold" INTEGER NOT NULL DEFAULT 3,
    "auto_downgrade_reason" TEXT,
    "auto_downgraded_at" TIMESTAMP(3),
    "budget_alert_period" TEXT,
    "budget_alert_level" INTEGER NOT NULL DEFAULT 0,
    "ops_alert_signature" TEXT,
    "ops_alert_sent_at" TIMESTAMP(3),
    "provider" TEXT,
    "model" TEXT,
    "updated_by_id" TEXT,
    "updated_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_runs" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'scheduled',
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL,
    "overall_status" TEXT,
    "checks_run" INTEGER NOT NULL DEFAULT 0,
    "checks_failed" INTEGER NOT NULL DEFAULT 0,
    "findings_total" INTEGER NOT NULL DEFAULT 0,
    "findings_info" INTEGER NOT NULL DEFAULT 0,
    "findings_warning" INTEGER NOT NULL DEFAULT 0,
    "findings_critical" INTEGER NOT NULL DEFAULT 0,
    "incidents_opened" INTEGER NOT NULL DEFAULT 0,
    "incidents_updated" INTEGER NOT NULL DEFAULT 0,
    "incidents_resolved" INTEGER NOT NULL DEFAULT 0,
    "actions_executed" INTEGER NOT NULL DEFAULT 0,
    "approvals_created" INTEGER NOT NULL DEFAULT 0,
    "alerts_sent" INTEGER NOT NULL DEFAULT 0,
    "ai_invoked" BOOLEAN NOT NULL DEFAULT false,
    "ai_skipped_reason" TEXT,
    "summary" TEXT,
    "check_errors" JSONB,
    "report" JSONB,
    "error" TEXT,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "correlation_id" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "service" TEXT NOT NULL DEFAULT 'unknown',
    "source" TEXT NOT NULL DEFAULT 'scheduled',
    "deployment_id" TEXT,
    "checks_completed_at" TIMESTAMP(3),
    "ai_skipped_count" INTEGER NOT NULL DEFAULT 0,
    "ai_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "email_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_findings" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "check_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "campaign_id" TEXT,
    "run_ref_id" TEXT,
    "send_id" TEXT,
    "webhook_event_id" TEXT,
    "suggested_actions" JSONB,
    "first_detected_at" TIMESTAMP(3) NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "incident_id" TEXT,

    CONSTRAINT "email_agent_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_incidents" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "technical_summary" TEXT,
    "probable_cause" TEXT,
    "confidence" DOUBLE PRECISION,
    "affected_campaign_ids" JSONB,
    "affected_run_ids" JSONB,
    "affected_send_ids" JSONB,
    "affected_event_ids" JSONB,
    "affected_count" INTEGER NOT NULL DEFAULT 1,
    "recommendation" JSONB,
    "resolution" TEXT,
    "resolution_kind" TEXT,
    "detection_count" INTEGER NOT NULL DEFAULT 1,
    "evidence_hash" TEXT,
    "investigated_evidence_hash" TEXT,
    "last_investigated_at" TIMESTAMP(3),
    "reinvestigate_requested_at" TIMESTAMP(3),
    "investigation_count" INTEGER NOT NULL DEFAULT 0,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "last_alert_at" TIMESTAMP(3),
    "last_alert_severity" TEXT,
    "last_alert_scope" INTEGER,
    "alert_count" INTEGER NOT NULL DEFAULT 0,
    "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_incident_events" (
    "id" TEXT NOT NULL,
    "incident_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_agent_incident_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_actions" (
    "id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "policy_classification" TEXT NOT NULL,
    "policy_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'started',
    "before_state" JSONB,
    "after_state" JSONB,
    "result" JSONB,
    "error" TEXT,
    "actor" TEXT NOT NULL DEFAULT 'agent',
    "actor_name" TEXT,
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "idempotency_key" TEXT,
    "correlation_id" TEXT NOT NULL,
    "run_id" TEXT,
    "incident_id" TEXT,
    "approval_id" TEXT,
    "campaign_id" TEXT,
    "run_ref_id" TEXT,
    "send_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "service" TEXT NOT NULL DEFAULT 'unknown',
    "arguments_hash" TEXT,

    CONSTRAINT "email_agent_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_approvals" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "incident_id" TEXT,
    "tool_name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "question" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expected_effect" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "campaign_id" TEXT,
    "run_ref_id" TEXT,
    "send_id" TEXT,
    "resource_checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by_id" TEXT,
    "decided_by_name" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "invalidation_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "executed_at" TIMESTAMP(3),
    "executed_by_id" TEXT,

    CONSTRAINT "email_agent_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_lessons" (
    "id" TEXT NOT NULL,
    "pattern_key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "symptoms" JSONB NOT NULL,
    "probable_cause" TEXT NOT NULL,
    "successful_resolution" TEXT,
    "failed_approaches" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "false_positives" INTEGER NOT NULL DEFAULT 0,
    "related_check_ids" JSONB,
    "first_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_agent_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "email_agent_model_calls" (
    "id" TEXT NOT NULL,
    "run_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "request_id" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'investigate',
    "outcome" TEXT NOT NULL,
    "error" TEXT,
    "prompt_tokens" INTEGER,
    "completion_tokens" INTEGER,
    "total_tokens" INTEGER,
    "latency_ms" INTEGER,
    "cached_input_tokens" INTEGER,
    "reasoning_tokens" INTEGER,
    "estimated_cost_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pricing_version" TEXT,
    "is_fallback" BOOLEAN NOT NULL DEFAULT false,
    "fallback_reason" TEXT,
    "environment" TEXT NOT NULL DEFAULT 'unknown',
    "incident_id" TEXT,
    "input_finding_count" INTEGER,
    "recommended_tool" TEXT,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_agent_model_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "deposit_requests" (
    "id" TEXT NOT NULL,
    "public_token" TEXT NOT NULL,
    "booking_id" TEXT,
    "lead_id" TEXT,
    "customer_name" TEXT,
    "customer_email" TEXT,
    "customer_phone" TEXT,
    "quote_total_cents" INTEGER,
    "balance_before_cents" INTEGER,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "service_summary" TEXT,
    "move_details" TEXT[],
    "customer_note" TEXT,
    "internal_note" TEXT,
    "move_date" TIMESTAMP(3),
    "move_time_minutes" INTEGER,
    "status" "DepositRequestStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMP(3),
    "stripe_checkout_session_id" TEXT,
    "stripe_checkout_url" TEXT,
    "checkout_session_expires_at" TIMESTAMP(3),
    "checkout_attempts" INTEGER NOT NULL DEFAULT 0,
    "stripe_payment_intent_id" TEXT,
    "stripe_event_id" TEXT,
    "amount_paid_cents" INTEGER,
    "paid_at" TIMESTAMP(3),
    "payment_id" TEXT,
    "livemode" BOOLEAN,
    "created_by_id" TEXT,
    "created_by_name" TEXT,
    "discord_status" "DepositNotifyStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "discord_notified_at" TIMESTAMP(3),
    "discord_retry_count" INTEGER NOT NULL DEFAULT 0,
    "discord_claimed_at" TIMESTAMP(3),
    "discord_message_id" TEXT,
    "discord_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "customers_email_key" ON "customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_display_id_key" ON "bookings"("display_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_booking_reference_key" ON "bookings"("booking_reference");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_stripe_checkout_id_key" ON "bookings"("stripe_checkout_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_stripe_payment_intent_id_key" ON "bookings"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_customer_token_key" ON "bookings"("customer_token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_customer_id_idx" ON "bookings"("customer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_confirmed_date_idx" ON "bookings"("confirmed_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_customer_token_idx" ON "bookings"("customer_token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_completed_at_idx" ON "bookings"("completed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_source_idx" ON "bookings"("source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_owner_assigned_source_idx" ON "bookings"("owner_assigned_source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_origin_city_idx" ON "bookings"("origin_city");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bookings_attribution_id_idx" ON "bookings"("attribution_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "lead_notifications_dedupe_key_key" ON "lead_notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "lead_notifications_status_next_attempt_at_idx" ON "lead_notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "lead_notifications_lead_id_idx" ON "lead_notifications"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_jobs_idempotency_key_key" ON "email_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_jobs_status_next_attempt_at_idx" ON "email_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_jobs_booking_id_idx" ON "email_jobs"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_payment_intent_id_key" ON "payments"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payments_stripe_charge_id_key" ON "payments"("stripe_charge_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payments_method_idx" ON "payments"("method");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_booking_id_key" ON "jobs"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "job_crew_crew_job_id_key" ON "job_crew"("crew_job_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_crew_job_id_idx" ON "job_crew"("job_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_crew_user_id_idx" ON "job_crew"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_crew_approval_status_idx" ON "job_crew"("approval_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_crew_payment_status_idx" ON "job_crew"("payment_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_crew_assignment_status_idx" ON "job_crew"("assignment_status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_crew_scheduled_start_at_idx" ON "job_crew"("scheduled_start_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "job_crew_job_id_user_id_key" ON "job_crew"("job_id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "labor_payments_job_crew_id_idx" ON "labor_payments"("job_crew_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "labor_payments_paid_on_idx" ON "labor_payments"("paid_on");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "labor_payments_voided_idx" ON "labor_payments"("voided");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "availability_date_idx" ON "availability"("date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "availability_user_id_date_key" ON "availability"("user_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "day_blocks_date_key" ON "day_blocks"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "day_blocks_date_idx" ON "day_blocks"("date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "availability_rules_user_id_day_of_week_idx" ON "availability_rules"("user_id", "day_of_week");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "availability_exceptions_user_id_date_idx" ON "availability_exceptions"("user_id", "date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "availability_exceptions_date_idx" ON "availability_exceptions"("date");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "job_staffing_requirements_job_id_key" ON "job_staffing_requirements"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "crew_invitations_token_key" ON "crew_invitations"("token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crew_invitations_email_idx" ON "crew_invitations"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crew_invitations_status_idx" ON "crew_invitations"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "conflict_overrides_job_id_idx" ON "conflict_overrides"("job_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "conflict_overrides_job_crew_id_idx" ON "conflict_overrides"("job_crew_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "assignment_notifications_dedupe_key_key" ON "assignment_notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "assignment_notifications_job_crew_id_idx" ON "assignment_notifications"("job_crew_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "files_cloudinary_id_key" ON "files"("cloudinary_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "files_booking_id_idx" ON "files"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "files_job_id_idx" ON "files"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "receipts_booking_id_key" ON "receipts"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_open_token_key" ON "notifications"("open_token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_booking_id_idx" ON "notifications"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_logs_event_id_key" ON "webhook_logs"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_logs_source_idx" ON "webhook_logs"("source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_logs_event_type_idx" ON "webhook_logs"("event_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_logs_created_at_idx" ON "webhook_logs"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_booking_id_idx" ON "audit_logs"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_keys_key_key" ON "idempotency_keys"("key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "manual_events_event_type_idx" ON "manual_events"("event_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "manual_events_zip_idx" ON "manual_events"("zip");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "manual_events_created_at_idx" ON "manual_events"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_status_idx" ON "tasks"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_owner_idx" ON "tasks"("owner");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tasks_due_date_idx" ON "tasks"("due_date");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "followup_ledger_booking_id_idx" ON "followup_ledger"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "followup_ledger_status_next_attempt_at_idx" ON "followup_ledger"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "followup_ledger_booking_id_type_key" ON "followup_ledger"("booking_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_booking_id_key" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reviews_booking_id_idx" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "expenses_booking_id_idx" ON "expenses"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "expenses_category_idx" ON "expenses"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "expenses_status_idx" ON "expenses"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "expenses_incurred_on_idx" ON "expenses"("incurred_on");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_transactions_owner_idx" ON "owner_transactions"("owner");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_transactions_type_idx" ON "owner_transactions"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_transactions_occurred_on_idx" ON "owner_transactions"("occurred_on");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_status_idx" ON "crm_leads"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_source_idx" ON "crm_leads"("source");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_created_at_idx" ON "crm_leads"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_email_idx" ON "crm_leads"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_phone_idx" ON "crm_leads"("phone");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_last_activity_at_idx" ON "crm_leads"("last_activity_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_booking_session_id_idx" ON "crm_leads"("booking_session_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "crm_leads_attribution_id_idx" ON "crm_leads"("attribution_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "reminders_dedupe_key_key" ON "reminders"("dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reminders_status_idx" ON "reminders"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reminders_severity_idx" ON "reminders"("severity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reminders_category_idx" ON "reminders"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reminders_due_at_idx" ON "reminders"("due_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reminders_assigned_owner_idx" ON "reminders"("assigned_owner");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reminders_source_entity_type_source_entity_id_idx" ON "reminders"("source_entity_type", "source_entity_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scan_runs_status_idx" ON "scan_runs"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scan_runs_started_at_idx" ON "scan_runs"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "roadmap_items_seed_key_key" ON "roadmap_items"("seed_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "roadmap_items_status_idx" ON "roadmap_items"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "roadmap_items_category_idx" ON "roadmap_items"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "roadmap_items_priority_idx" ON "roadmap_items"("priority");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "move_closeouts_booking_id_key" ON "move_closeouts"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "move_closeouts_status_idx" ON "move_closeouts"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "move_closeouts_finalized_at_idx" ON "move_closeouts"("finalized_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "financial_snapshots_booking_id_idx" ON "financial_snapshots"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "financial_snapshots_superseded_at_idx" ON "financial_snapshots"("superseded_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "financial_snapshots_closeout_id_version_key" ON "financial_snapshots"("closeout_id", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reserve_allocations_closeout_id_idx" ON "reserve_allocations"("closeout_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "reserve_allocations_kind_idx" ON "reserve_allocations"("kind");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_distributions_owner_idx" ON "owner_distributions"("owner");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_distributions_booking_id_idx" ON "owner_distributions"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "owner_distributions_status_idx" ON "owner_distributions"("status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "marketing_campaigns_qr_identifier_key" ON "marketing_campaigns"("qr_identifier");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "marketing_campaigns_status_idx" ON "marketing_campaigns"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "marketing_campaigns_source_key_idx" ON "marketing_campaigns"("source_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "marketing_campaigns_channel_idx" ON "marketing_campaigns"("channel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "marketing_spend_campaign_id_idx" ON "marketing_spend"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "marketing_spend_incurred_on_idx" ON "marketing_spend"("incurred_on");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "saved_report_views_report_type_idx" ON "saved_report_views"("report_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "saved_report_views_shared_idx" ON "saved_report_views"("shared");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "saved_report_views_created_by_id_report_type_name_key" ON "saved_report_views"("created_by_id", "report_type", "name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_exports_report_type_idx" ON "report_exports"("report_type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_exports_requested_by_id_idx" ON "report_exports"("requested_by_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "report_exports_created_at_idx" ON "report_exports"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_key" ON "email_suppressions"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_suppressions_reason_idx" ON "email_suppressions"("reason");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_suppressions_created_at_idx" ON "email_suppressions"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_sends_idempotency_key_key" ON "email_sends"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_email_idx" ON "email_sends"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_status_idx" ON "email_sends"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_journey_idx" ON "email_sends"("journey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_booking_id_idx" ON "email_sends"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_lead_id_idx" ON "email_sends"("lead_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_created_at_idx" ON "email_sends"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_campaign_id_idx" ON "email_sends"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_is_test_idx" ON "email_sends"("is_test");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_status_next_attempt_at_idx" ON "email_sends"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_email_email_class_status_sent_at_idx" ON "email_sends"("email", "email_class", "status", "sent_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_bounced_at_idx" ON "email_sends"("bounced_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_sends_complained_at_idx" ON "email_sends"("complained_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_events_provider_event_id_key" ON "email_events"("provider_event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_events_email_idx" ON "email_events"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_events_type_idx" ON "email_events"("type");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_events_email_send_id_idx" ON "email_events"("email_send_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_events_occurred_at_idx" ON "email_events"("occurred_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_events_processing_status_idx" ON "email_events"("processing_status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_audiences_name_key" ON "email_audiences"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_audiences_created_at_idx" ON "email_audiences"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_configs_campaign_id_key" ON "email_campaign_configs"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_configs_audience_id_idx" ON "email_campaign_configs"("audience_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_configs_scheduled_at_idx" ON "email_campaign_configs"("scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_journey_configs_journey_key_key" ON "email_journey_configs"("journey_key");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_automations_name_key" ON "email_automations"("name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automations_status_idx" ON "email_automations"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automation_versions_automation_id_idx" ON "email_automation_versions"("automation_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_automation_versions_automation_id_version_key" ON "email_automation_versions"("automation_id", "version");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_runs_campaign_id_idx" ON "email_campaign_runs"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_runs_status_idx" ON "email_campaign_runs"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_runs_started_at_idx" ON "email_campaign_runs"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_recipients_email_send_id_key" ON "email_campaign_recipients"("email_send_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_recipients_run_id_status_idx" ON "email_campaign_recipients"("run_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_campaign_recipients_email_idx" ON "email_campaign_recipients"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_campaign_recipients_run_id_email_key" ON "email_campaign_recipients"("run_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_automation_enrollments_dedupe_key_key" ON "email_automation_enrollments"("dedupe_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_automation_id_status_idx" ON "email_automation_enrollments"("automation_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_status_next_run_at_idx" ON "email_automation_enrollments"("status", "next_run_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_email_idx" ON "email_automation_enrollments"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_booking_id_idx" ON "email_automation_enrollments"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_automation_enrollments_lead_id_idx" ON "email_automation_enrollments"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_agent_runs_correlation_id_key" ON "email_agent_runs"("correlation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_runs_started_at_idx" ON "email_agent_runs"("started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_runs_status_idx" ON "email_agent_runs"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_runs_trigger_idx" ON "email_agent_runs"("trigger");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_runs_environment_service_started_at_idx" ON "email_agent_runs"("environment", "service", "started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_fingerprint_idx" ON "email_agent_findings"("fingerprint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_check_id_idx" ON "email_agent_findings"("check_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_severity_idx" ON "email_agent_findings"("severity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_campaign_id_idx" ON "email_agent_findings"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_run_ref_id_idx" ON "email_agent_findings"("run_ref_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_send_id_idx" ON "email_agent_findings"("send_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_detected_at_idx" ON "email_agent_findings"("detected_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_incident_id_idx" ON "email_agent_findings"("incident_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_findings_run_id_idx" ON "email_agent_findings"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_agent_incidents_reference_key" ON "email_agent_incidents"("reference");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_status_idx" ON "email_agent_incidents"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_fingerprint_idx" ON "email_agent_incidents"("fingerprint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_severity_idx" ON "email_agent_incidents"("severity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_category_idx" ON "email_agent_incidents"("category");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_last_detected_at_idx" ON "email_agent_incidents"("last_detected_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_created_at_idx" ON "email_agent_incidents"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_status_severity_idx" ON "email_agent_incidents"("status", "severity");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_evidence_hash_idx" ON "email_agent_incidents"("evidence_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_last_investigated_at_idx" ON "email_agent_incidents"("last_investigated_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incidents_environment_idx" ON "email_agent_incidents"("environment");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incident_events_incident_id_created_at_idx" ON "email_agent_incident_events"("incident_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_incident_events_kind_idx" ON "email_agent_incident_events"("kind");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_agent_actions_idempotency_key_key" ON "email_agent_actions"("idempotency_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_tool_name_idx" ON "email_agent_actions"("tool_name");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_status_idx" ON "email_agent_actions"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_started_at_idx" ON "email_agent_actions"("started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_incident_id_idx" ON "email_agent_actions"("incident_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_correlation_id_idx" ON "email_agent_actions"("correlation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_campaign_id_idx" ON "email_agent_actions"("campaign_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_run_ref_id_idx" ON "email_agent_actions"("run_ref_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_environment_started_at_idx" ON "email_agent_actions"("environment", "started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_tool_name_started_at_idx" ON "email_agent_actions"("tool_name", "started_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_actions_arguments_hash_idx" ON "email_agent_actions"("arguments_hash");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_agent_approvals_reference_key" ON "email_agent_approvals"("reference");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_approvals_status_idx" ON "email_agent_approvals"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_approvals_expires_at_idx" ON "email_agent_approvals"("expires_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_approvals_incident_id_idx" ON "email_agent_approvals"("incident_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_approvals_created_at_idx" ON "email_agent_approvals"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "email_agent_lessons_pattern_key_key" ON "email_agent_lessons"("pattern_key");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_lessons_last_observed_at_idx" ON "email_agent_lessons"("last_observed_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_lessons_confidence_idx" ON "email_agent_lessons"("confidence");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_model_calls_created_at_idx" ON "email_agent_model_calls"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_model_calls_provider_idx" ON "email_agent_model_calls"("provider");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_model_calls_outcome_idx" ON "email_agent_model_calls"("outcome");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_model_calls_correlation_id_idx" ON "email_agent_model_calls"("correlation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_model_calls_environment_created_at_idx" ON "email_agent_model_calls"("environment", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "email_agent_model_calls_incident_id_idx" ON "email_agent_model_calls"("incident_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_public_token_key" ON "deposit_requests"("public_token");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_stripe_checkout_session_id_key" ON "deposit_requests"("stripe_checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_requests_stripe_payment_intent_id_key" ON "deposit_requests"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deposit_requests_booking_id_idx" ON "deposit_requests"("booking_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deposit_requests_status_idx" ON "deposit_requests"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deposit_requests_created_at_idx" ON "deposit_requests"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "deposit_requests_discord_status_idx" ON "deposit_requests"("discord_status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "job_crew" ADD CONSTRAINT "job_crew_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "labor_payments" ADD CONSTRAINT "labor_payments_job_crew_id_fkey" FOREIGN KEY ("job_crew_id") REFERENCES "job_crew"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "availability" ADD CONSTRAINT "availability_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "job_staffing_requirements" ADD CONSTRAINT "job_staffing_requirements_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "files" ADD CONSTRAINT "files_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "files" ADD CONSTRAINT "files_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "receipts" ADD CONSTRAINT "receipts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "followup_ledger" ADD CONSTRAINT "followup_ledger_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "expenses" ADD CONSTRAINT "expenses_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "move_closeouts" ADD CONSTRAINT "move_closeouts_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "financial_snapshots" ADD CONSTRAINT "financial_snapshots_closeout_id_fkey" FOREIGN KEY ("closeout_id") REFERENCES "move_closeouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "reserve_allocations" ADD CONSTRAINT "reserve_allocations_closeout_id_fkey" FOREIGN KEY ("closeout_id") REFERENCES "move_closeouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "marketing_spend" ADD CONSTRAINT "marketing_spend_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_send_id_fkey" FOREIGN KEY ("email_send_id") REFERENCES "email_sends"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_campaign_configs" ADD CONSTRAINT "email_campaign_configs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_campaign_configs" ADD CONSTRAINT "email_campaign_configs_audience_id_fkey" FOREIGN KEY ("audience_id") REFERENCES "email_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_automation_versions" ADD CONSTRAINT "email_automation_versions_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "email_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_campaign_runs" ADD CONSTRAINT "email_campaign_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "marketing_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_campaign_recipients" ADD CONSTRAINT "email_campaign_recipients_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_campaign_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_automation_enrollments" ADD CONSTRAINT "email_automation_enrollments_automation_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "email_automations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_findings" ADD CONSTRAINT "email_agent_findings_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_findings" ADD CONSTRAINT "email_agent_findings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_agent_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_incident_events" ADD CONSTRAINT "email_agent_incident_events_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_actions" ADD CONSTRAINT "email_agent_actions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_actions" ADD CONSTRAINT "email_agent_actions_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_actions" ADD CONSTRAINT "email_agent_actions_approval_id_fkey" FOREIGN KEY ("approval_id") REFERENCES "email_agent_approvals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_approvals" ADD CONSTRAINT "email_agent_approvals_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "email_agent_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "email_agent_model_calls" ADD CONSTRAINT "email_agent_model_calls_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "email_agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN duplicate_table THEN NULL; END $$;

-- ═══════════════════════════════════════════════════════════════════════════
--  OBJECTS PRISMA CANNOT EXPRESS
--
--  A PARTIAL unique index has no representation in the Prisma datamodel, so it
--  would be missing from any database built from the generated baseline alone —
--  and its absence is silent. Without it, two concurrent captures on one
--  browser session create duplicate leads, and every test still passes, because
--  the race only appears under real concurrency.
--
--  It is repeated here so a rebuilt database is actually correct rather than
--  merely well-formed. The authoritative copy remains
--  20260825150000_lead_session_unique; this is the same statement.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS "crm_leads_open_booking_session_key"
    ON "crm_leads" ("booking_session_id")
 WHERE "booking_session_id" IS NOT NULL
   AND "status" IN ('NEW', 'CONTACTED', 'QUOTE_SENT', 'FOLLOW_UP');
