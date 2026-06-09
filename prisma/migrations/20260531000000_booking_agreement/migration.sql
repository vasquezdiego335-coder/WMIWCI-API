-- Moving Service Agreement acceptance record
ALTER TABLE "bookings"
ADD COLUMN "agreement_accepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "agreement_version" TEXT,
ADD COLUMN "agreement_accepted_at" TIMESTAMP(3),
ADD COLUMN "agreement_name" TEXT,
ADD COLUMN "agreement_signature" TEXT;
