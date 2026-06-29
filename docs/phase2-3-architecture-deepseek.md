# Moving Company Software Design Document — Phase 2 & 3

## 1. Executive Summary & Corrected Follow-Up Timeline

**Core Problem:** The owner wants to ask for referrals immediately after a $49 hold is authorized, before the move happens. This is TCPA-risky and poor customer experience — the customer hasn't experienced service yet.

**Corrected Sequence:** All follow-ups are gated on job COMPLETION, not payment. The only post-payment action is the FINAL CONFIRMATION (existing). Referral asks happen AFTER positive experience signals.

| Event | Channel | Delay | Dedup Key | TCPA Basis |
|-------|---------|-------|-----------|------------|
| Payment (fulfillPaidCheckout) | SMS+Email | Immediate | `final-confirmation:{bookingId}` | Transactional (existing) |
| Job Completed | — | Immediate (hook) | — | — |
| Review Request | SMS+Email | 1 hour after completion | `review-request:{bookingId}` | Existing business relationship |
| Repeat Business Reminder | SMS+Email | 2 hours after completion | `repeat-reminder:{bookingId}` | Existing business relationship |
| Referral Ask (post-completion) | SMS+Email | 3 hours after completion | `referral-ask:{bookingId}` | Existing business relationship |
| Review Reminder (if no review) | SMS+Email | 48 hours after completion | `review-reminder:{bookingId}` | Existing business relationship |
| Referral Ask (positive review) | SMS+Email | 1 hour after positive review | `referral-positive:{bookingId}` | Existing business relationship |

**Why:** Separating payment from follow-ups prevents spam and TCPA violations. All marketing messages are sent under existing-business-relationship exemption after service delivery.

## 2. Phase 2 — Attribution Merge

### 2.1 Prisma Schema Delta (WMIWCI-API)

```prisma
// Add to schema.prisma
model Booking {
  // ... existing fields ...
  source    String?   @default("direct") // QR code source code
  foundUs   String?   // "google", "facebook", "referral", "yelp", "nextdoor", "other"
  
  // Phase 3 additions
  completedAt DateTime?
  review     Review?
  followUpLedgers FollowUpLedger[]
}

model FollowUpLedger {
  id          String   @id @default(cuid())
  bookingId   String
  type        String   // "review-request", "repeat-reminder", "referral-ask", "review-reminder", "referral-positive"
  channel     String   // "sms", "email", "both"
  sentAt      DateTime @default(now())
  status      String   @default("sent") // "sent", "failed", "skipped"
  error       String?
  
  booking     Booking  @relation(fields: [bookingId], references: [id])
  
  @@unique([bookingId, type]) // Exactly-once per type per booking
  @@index([bookingId])
}

model Review {
  id          String   @id @default(cuid())
  bookingId   String   @unique
  rating      Int      // 1-5
  source      String   // "admin", "customer-portal", "discord"
  leftAt      DateTime @default(now())
  isPositive  Boolean  @default(false) // rating >= 4
  comment     String?
  
  booking     Booking  @relation(fields: [bookingId], references: [id])
}
```

**Why:** `@@unique([bookingId, type])` on FollowUpLedger provides the exactly-once guarantee. Review model is separate to allow future expansion (Google reviews, etc.).

### 2.2 Marketing Tracker DDL + Healing

```sql
-- Add found_us to leads table
ALTER TABLE leads ADD COLUMN found_us TEXT DEFAULT NULL;

-- Add external_ref to jobs table (UNIQUE for idempotency)
ALTER TABLE jobs ADD COLUMN external_ref TEXT UNIQUE DEFAULT NULL;
CREATE INDEX idx_jobs_external_ref ON jobs(external_ref);

-- Healing: backfill existing bookings that were already paid
-- (Run once after deployment)
UPDATE jobs SET external_ref = 'booking:' || j.id 
FROM jobs j 
WHERE jobs.external_ref IS NULL 
AND jobs.id IN (SELECT job_id FROM leads WHERE ...);
```

**Why:** UNIQUE constraint on external_ref ensures Stripe webhook + success redirect can both call without duplicates.

### 2.3 /api/ingest/booking Contract

**Endpoint:** `POST /api/ingest/booking`
**Auth:** Bearer token in `Authorization` header (TRACKER_INGEST_TOKEN env var)

**Request Body:**
```json
{
  "external_ref": "booking:clx123abc",
  "source_code": "qr-spring2024",
  "found_us": "google",
  "name": "John Doe",
  "phone": "+15551234567",
  "email": "john@example.com",
  "message": "2-bedroom apartment move, June 15",
  "revenue_cents": 4900,
  "scheduled_date": "2024-06-15",
  "completed_date": null,
  "notes": "Deposit paid, pending move"
}
```

**Idempotency:** Upsert on `external_ref` — if job exists, update revenue_cents and notes; if lead exists, update. Returns 200 on success, 409 on conflict (shouldn't happen with upsert).

**Response:**
```json
{
  "status": "ok",
  "lead_id": 123,
  "job_id": 456
}
```

### 2.4 Dropdown Options for "Where did you find us?"

```typescript
const FOUND_US_OPTIONS = [
  { value: 'google', label: { en: 'Google Search', es: 'Búsqueda de Google' } },
  { value: 'facebook', label: { en: 'Facebook / Instagram', es: 'Facebook / Instagram' } },
  { value: 'yelp', label: { en: 'Yelp', es: 'Yelp' } },
  { value: 'nextdoor', label: { en: 'Nextdoor', es: 'Nextdoor' } },
  { value: 'referral', label: { en: 'Friend or Family Referral', es: 'Recomendación de amigo o familiar' } },
  { value: 'flyer', label: { en: 'Flyer / Door Hanger', es: 'Volante / Colgador de puerta' } },
  { value: 'truck', label: { en: 'Saw Our Truck', es: 'Vio nuestro camión' } },
  { value: 'other', label: { en: 'Other', es: 'Otro' } },
];
```

**Why:** Mover-specific options (truck sighting, flyer) are more useful than generic "social media" for a local moving company.

### 2.5 Source vs FoundUs Reconciliation

- `source` = QR code / tracking link attribution (automatic, from URL param)
- `foundUs` = customer self-report (from form dropdown)
- In tracker stats: `found_us` breakdown is primary; `source_code` is secondary fallback
- If both exist, `found_us` takes precedence in reporting

### 2.6 fulfillPaidCheckout Integration

```typescript
// In src/lib/fulfillment.ts, after existing logic:
async function ingestToTracker(booking: Booking) {
  if (!process.env.TRACKER_INGEST_TOKEN) return; // Skip if not configured
  
  const payload = {
    external_ref: `booking:${booking.id}`,
    source_code: booking.source || 'direct',
    found_us: booking.foundUs || null,
    name: booking.customer.name,
    phone: booking.customer.phone,
    email: booking.customer.email,
    message: `Move booked: ${booking.itemsDescription?.substring(0, 200)}`,
    revenue_cents: 4900, // Deposit amount
    scheduled_date: booking.requestedDate?.toISOString().split('T')[0],
    completed_date: null,
    notes: `Booking ${booking.displayId} - deposit paid`
  };
  
  // Fire-and-forget, never block customer
  fetch(`${process.env.TRACKER_URL}/api/ingest/booking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.TRACKER_INGEST_TOKEN}`
    },
    body: JSON.stringify(payload)
  }).catch(err => console.error('Tracker ingest failed (non-fatal):', err));
}
```

**Why:** Fire-and-forget with `.catch()` ensures customer experience is never blocked by tracker availability.

## 3. Phase 3 — Moving Follow-Up Automation

### 3.1 The completeJob Hook

```typescript
// src/lib/completeJob.ts
import { prisma } from './prisma';
import { scheduledQueue } from '../workers/scheduled.worker';

export async function completeJob(bookingId: string): Promise<void> {
  const booking = await prisma.booking.update({
    where: { id: bookingId, status: 'COMPLETED' },
    data: { 
      status: 'COMPLETED',
      completedAt: new Date()
    },
    include: { customer: true }
  });
  
  if (!booking) return; // Already completed or wrong status
  
  // Schedule follow-ups with delays
  const now = Date.now();
  
  // (b) Review request - 1 hour after completion
  await scheduleFollowUp(booking, 'review-request', now + 60 * 60 * 1000);
  
  // (c) Repeat business reminder - 2 hours after completion
  await scheduleFollowUp(booking, 'repeat-reminder', now + 2 * 60 * 60 * 1000);
  
  // (d) Review reminder - 48 hours, conditional (handled in worker)
  await scheduleFollowUp(booking, 'review-reminder', now + 48 * 60 * 60 * 1000);
  
  // (a) Referral ask - 3 hours after completion (not at payment!)
  await scheduleFollowUp(booking, 'referral-ask', now + 3 * 60 * 60 * 1000);
}

async function scheduleFollowUp(booking: any, type: string, delay: number) {
  await scheduledQueue.add(
    `followup:${type}:${booking.id}`,
    { type, bookingId: booking.id, customerId: booking.customer.id },
    { delay: delay - Date.now(), jobId: `followup:${type}:${booking.id}` }
  );
}
```

**Why:** Single hook callable from both admin route and Discord ensures consistency. Delayed jobs handle timing.

### 3.2 The 5 Follow-Up Flows

#### Flow (b) — Review Request (1h post-completion)
```typescript
// In scheduled.worker.ts handler
case 'review-request': {
  const booking = await prisma.booking.findUnique({
    where: { id: data.bookingId },
    include: { customer: true }
  });
  
  // Check ledger
  const alreadySent = await prisma.followUpLedger.findUnique({
    where: { bookingId_type: { bookingId: data.bookingId, type: 'review-request' } }
  });
  if (alreadySent) return;
  
  // Send SMS + Email
  const smsMessage = t(booking.customer.locale, 'review.request.sms', { name: booking.customer.name });
  await smsQueue.add('review-request', { to: booking.customer.phone, message: smsMessage });
  
  const emailHtml = `<p>${t(booking.customer.locale, 'review.request.email', { name: booking.customer.name })}</p>`;
  await resend.emails.send({
    from: EMAIL_FROM,
    to: booking.customer.email,
    subject: t(booking.customer.locale, 'review.request.subject'),
    html: emailHtml
  });
  
  // Record in ledger
  await prisma.followUpLedger.create({
    data: { bookingId: data.bookingId, type: 'review-request', channel: 'both', status: 'sent' }
  });
}
```

#### Flow (c) — Repeat Business Reminder (2h post-completion)
Same pattern as (b) but with `repeat-reminder` type and different i18n keys.

#### Flow (d) — Review Reminder (48h, conditional)
```typescript
case 'review-reminder': {
  const review = await prisma.review.findUnique({ where: { bookingId: data.bookingId } });
  if (review) return; // Already left a review, skip
  
  // Same send pattern as (b) but with 'review-reminder' type
}
```

#### Flow (a) — Referral Ask (3h post-completion)
```typescript
case 'referral-ask': {
  // Same pattern, type: 'referral-ask'
}
```

#### Flow (e) — Referral Ask on Positive Review
```typescript
// In the review creation handler (admin/Discord/customer-portal)
async function handleReviewCreated(bookingId: string, rating: number) {
  const isPositive = rating >= 4;
  
  await prisma.review.create({
    data: { bookingId, rating, source: 'admin', isPositive, leftAt: new Date() }
  });
  
  if (isPositive) {
    // Schedule referral ask 1 hour later
    await scheduledQueue.add(
      `followup:referral-positive:${bookingId}`,
      { type: 'referral-positive', bookingId, customerId: booking.customer.id },
      { delay: 60 * 60 * 1000, jobId: `followup:referral-positive:${bookingId}` }
    );
  }
}
```

### 3.3 TCPA Compliance Rules

```typescript
// In each follow-up handler, before sending:
async function canSendMarketing(booking: Booking, customer: Customer): Promise<boolean> {
  // 1. Opt-out check
  if (customer.marketingOptOut) return false;
  
  // 2. Quiet hours (9pm-8am Eastern)
  const hour = new Date().getHours();
  if (hour < 8 || hour >= 21) return false;
  
  // 3. Frequency cap: max 2 marketing messages per 7 days
  const recentCount = await prisma.followUpLedger.count({
    where: {
      booking: { customerId: customer.id },
      sentAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }
  });
  if (recentCount >= 2) return false;
  
  return true;
}
```

**Why:** Three-layer protection (opt-out, quiet hours, frequency cap) ensures TCPA compliance even if scheduling logic has bugs.

### 3.4 i18n Keys to Add

```typescript
// In src/lib/i18n.ts catalog
'review.request.sms': {
  en: 'Hi {name}, how was your move with We Move It We Clear It? Leave a review: {reviewLink}',
  es: 'Hola {name}, ¿cómo fue su mudanza con We Move It We Clear It? Deje una reseña: {reviewLink}'
},
'review.request.email': {
  en: 'We hope you loved your move! Please take a moment to review us...',
  es: '¡Esperamos que le haya encantado su mudanza! Tómese un momento para reseñarnos...'
},
'repeat-reminder.sms': {
  en: 'Hi {name}, need help moving again or clearing junk? We offer 10% off for repeat customers!',
  es: 'Hola {name}, ¿necesita ayuda con otra mudanza o limpieza? ¡Ofrecemos 10% de descuento para clientes recurrentes!'
},
'referral-ask.sms': {
  en: 'Know someone moving? Refer them to We Move It We Clear It and you both get $25 off!',
  es: '¿Conoce a alguien que se mude? ¡Refiéralo a We Move It We Clear It y ambos obtienen $25 de descuento!'
},
'review-reminder.sms': {
  en: 'Hi {name}, just a friendly reminder to leave us a review! {reviewLink}',
  es: 'Hola {name}, ¡un recordatorio amistoso para dejarnos una reseña! {reviewLink}'
},
'referral-positive.sms': {
  en: 'Thanks for the great review! Share your referral code {code} for $25 off your next move.',
  es: '¡Gracias por la excelente reseña! Comparta su código de referencia {code} para $25 de descuento en su próxima mudanza.'
}
```

## 4. Queue/Cron Architecture

### 4.1 Job Types

```typescript
// In src/workers/scheduled.worker.ts
type ScheduledJobData = 
  | { type: 'review-request'; bookingId: string; customerId: string }
  | { type: 'repeat-reminder'; bookingId: string; customerId: string }
  | { type: 'referral-ask'; bookingId: string; customerId: string }
  | { type: 'review-reminder'; bookingId: string; customerId: string }
  | { type: 'referral-positive'; bookingId: string; customerId: string }
  | { type: 'abandoned-checkout-recovery'; bookingId: string } // Existing
  | { type: 'review-request-48h'; bookingId: string }; // Existing (repurpose)
```

### 4.2 Cron Patterns

| Job | Pattern | TZ | Notes |
|-----|---------|-----|-------|
| Abandoned checkout recovery | (delayed 2h) | America/New_York | Existing |
| Review request | (delayed 1h post-completion) | — | Dynamic delay |
| Repeat reminder | (delayed 2h post-completion) | — | Dynamic delay |
| Referral ask | (delayed 3h post-completion) | — | Dynamic delay |
| Review reminder | (delayed 48h post-completion) | — | Dynamic delay |
| Referral on positive review | (delayed 1h post-review) | — | Dynamic delay |

**Why:** All follow-ups use delayed jobs (not cron) because they're triggered by events. No periodic cron needed for Phase 3.

### 4.3 Quiet-Hours Scheduling

```typescript
// When scheduling a delayed job, adjust for quiet hours
function scheduleInAllowedHours(delay: number): number {
  const targetTime = new Date(Date.now() + delay);
  const hour = targetTime.getHours();
  
  if (hour < 8) {
    // Move to 8am same day
    targetTime.setHours(8, 0, 0, 0);
  } else if (hour >= 21) {
    // Move to 8am next day
    targetTime.setDate(targetTime.getDate() + 1);
    targetTime.setHours(8, 0, 0, 0);
  }
  
  return targetTime.getTime() - Date.now();
}
```

**Why:** Prevents SMS from being sent during quiet hours even if completion happens at 10pm.

## 5. Reliability & Error Handling

### 5.1 Exactly-Once Guarantee

```typescript
// In each follow-up handler
const ledgerEntry = await prisma.followUpLedger.create({
  data: { bookingId, type, channel: 'both', status: 'sending' }
}).catch(err => {
  if (err.code === 'P2002') return null; // Unique constraint violation = already sent
  throw err;
});

if (!ledgerEntry) return; // Already processed
```

**Why:** Database-level unique constraint prevents duplicate sends even if BullMQ retries.

### 5.2 Non-Fatal Send Failures

```typescript
try {
  await smsQueue.add(type, { to, message });
} catch (err) {
  console.error(`SMS failed for ${type}:${bookingId}`, err);
  // Update ledger with error, don't block other sends
  await prisma.followUpLedger.update({
    where: { id: ledgerEntry.id },
    data: { status: 'failed', error: err.message }
  });
}
```

**Why:** SMS/email failures should never crash the worker or prevent other follow-ups.

### 5.3 Redis/Infrastructure Outages

- **Redis down:** BullMQ jobs won't process. Jobs remain in queue until Redis recovers. No data loss.
- **Twilio down:** SMS fails silently (logged). Email still sends. Retry on next worker restart.
- **Tracker down:** Fire-and-forget ingest fails silently. Revenue data can be backfilled later via healing script.
- **Postgres down:** Workers crash-loop until DB recovers. BullMQ retries with exponential backoff.

## 6. Hosting Layout & Cross-Service Auth

### 6.1 Service Map

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Vercel (Next.js) │     │  Railway (Worker)  │     │ Railway (Tracker) │
│  - App Router      │     │  - BullMQ Workers  │     │  - Flask API      │
│  - Serverless fns  │     │  - tsx workers     │     │  - Postgres       │
│  - Stripe webhook  │     │  - Scheduled jobs  │     │  - Landing page   │
│  - Admin API       │     │  - Email workers   │     │                   │
└────────┬──────────┘     └────────┬───────────┘     └────────┬──────────┘
         │                         │                          │
         │                    ┌────┴────┐               ┌─────┴──────┐
         │                    │ Upstash │               │  Tracker   │
         │                    │  Redis  │               │  Postgres  │
         │                    └─────────┘               └────────────┘
         │
    ┌────┴──────┐
    │  Neon     │
    │  Postgres │
    └───────────┘
```

### 6.2 Cross-Service Auth

```typescript
// WMIWCI-API → Tracker: Bearer token in env var
const TRACKER_INGEST_TOKEN = process.env.TRACKER_INGEST_TOKEN; // Shared secret

// Tracker → WMIWCI-API: Not needed (tracker doesn't call WMIWCI-API)
```

**Why:** Simple token auth is sufficient for server-to-server communication. No OAuth complexity needed.

## 7. Full Env-Var Map

### WMIWCI-API (Vercel + Railway Worker)

```
# Database
DATABASE_URL=postgresql://...
DIRECT_URL=postgresql://...  # For migrations

# Redis (Upstash)
UPSTASH_REDIS_URL=redis://...
UPSTASH_REDIS_TOKEN=...

# Twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TWILIO_ENABLED=true

# Resend
RESEND_API_KEY=re_...
EMAIL_FROM=We Move It <moves@wmwci.com>
EMAIL_REPLY_TO=team@wmwci.com

# Stripe
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_ID=price_...

# Tracker Integration (Phase 2)
TRACKER_URL=https://tracker.wmwci.com
TRACKER_INGEST_TOKEN=shared-secret-token

# Feature Flags
CUSTOMER_AUTOREPLY_ENABLED=true
MARKETING_FOLLOWUPS_ENABLED=true  # Phase 3 kill switch

# Discord
DISCORD_WEBHOOK_URL=...
DISCORD_BOT_TOKEN=...

# App
NEXT_PUBLIC_APP_URL=https://wmwci.com
NODE_ENV=production
```

### Marketing Tracker (Railway)

```
DATABASE_URL=postgresql://...
TRACKER_INGEST_TOKEN=shared-secret-token  # Must match WMIWCI-API
SECRET_KEY=flask-secret-key
```

## 8. Safe Deploy Order

### Phase 2 Deployment

1. **Tracker first:** Run ALTER TABLE migrations (add found_us, external_ref)
2. **Tracker second:** Deploy updated Flask app with /api/ingest/booking endpoint
3. **WMIWCI-API third:** Run Prisma migration (add source, foundUs to Booking)
4. **WMIWCI-API fourth:** Deploy updated Next.js app with form dropdown + fulfillPaidCheckout integration
5. **Verify:** Create test booking, confirm tracker receives data

### Phase 3 Deployment

1. **WMIWCI-API first:** Run Prisma migration (add FollowUpLedger, Review models)
2. **WMIWCI-API second:** Deploy updated worker with follow-up handlers
3. **WMIWCI-API third:** Deploy updated Next.js with completeJob hook
4. **Enable gradually:** Set MARKETING_FOLLOWUPS_ENABLED=true after monitoring
5. **Monitor:** Check FollowUpLedger table for successful sends after first completed job

### Rollback Plan

- **Phase 2:** Set TRACKER_INGEST_TOKEN to empty string (disables tracker integration)
- **Phase 3:** Set MARKETING_FOLLOWUPS_ENABLED=false (disables all follow-ups)
- **Database:** Prisma migrations are reversible with `prisma migrate down`

**Why:** Feature flags allow instant rollback without redeployment. Database changes are backward-compatible (new columns are nullable).