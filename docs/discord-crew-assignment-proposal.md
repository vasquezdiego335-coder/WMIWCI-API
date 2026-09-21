# Crew assignment on the Discord job cards — proposal

**Status: PROPOSAL. Nothing in the "needs approval" section below is built, and no
migration is proposed.** Written 2026-09-20 during the Discord server restructure.

## Correction to the 2026-09-20 audit

The audit said *"No crew-assignment model exists. This is the one real gap."*
**That was wrong.** A complete assignment system has existed since July:

| Piece | Where |
| --- | --- |
| The assignment record | `JobCrew` (`prisma/schema.prisma`) — one row per worker per move |
| Who the worker is | `JobCrew.userId → User` (an application user) |
| Crew Lead | `JobCrew.role = CREW_LEADER` and/or `JobCrew.crewLeader = true`; `User.canLeadCrew` gates who may be one |
| Driver | `JobCrew.isDriver` (explicit, never inferred) |
| When to arrive | `JobCrew.reportTime` — may differ from the job's start |
| Lifecycle | `CrewAssignmentStatus`: INVITED → OFFERED → ACCEPTED / ASSIGNED → IN_PROGRESS → COMPLETED, or DECLINED / CANCELLED / NO_SHOW (`src/lib/assignment-lifecycle.ts`) |
| How many are needed | `JobStaffingRequirement.requiredWorkers`, `requiredDrivers`, `requiresLead` |
| Assigning | Admin → move → **Crew & Labor** → *Add crew member* (`POST /api/admin/jobs/[bookingId]/crew`) |
| The worker's side | `POST /api/crew/assignments/[id]` — acknowledge or decline their own row |
| History | every change writes `AuditLog` (`CREW_ASSIGNED`, `CREW_ASSIGNMENT_CANCELLED`, …); a row with payments is cancelled with a reason, never deleted |
| Discord identity | `User.discordId` (nullable) |

So the question was never "what table do we need". It was **"why does Discord not
show what the admin already knows"** — and that is now answered in code.

## What is built (this change, no migration)

`src/lib/job-cards.ts` reads `Job.crew` and renders it on **both** cards and in
**both** daily digests:

```
CREW
3 movers
Diego (lead) · report 1:30 PM
Marcus (driver)
```

- **Source of truth is `JobCrew` only.** `laborWorkers` is used for the *count*
  line and nothing else; it never names anyone. With no count and nobody
  assigned, the CREW field does not exist.
- **Count** = `JobStaffingRequirement.requiredWorkers`, else `laborWorkers`, else
  omitted. Never guessed.
- **Only live assignments** appear (INVITED, OFFERED, ACCEPTED, ASSIGNED,
  IN_PROGRESS, COMPLETED). DECLINED, CANCELLED and NO_SHOW drop off the card.
- **First names only** on anything crew-visible.
- **The owner card flags a confirmed job with nobody assigned** under NEEDS
  ATTENTION; the digest prints `Crew: not assigned yet`.
- **Changes repaint the card.** Every assignment route — assign, edit, remove,
  offer/cancel, and the worker's own acknowledge/decline — queues a
  `booking-card-sync`, so `#job-data` and `#today-jobs` are correct within seconds.

### A worker who is not on Discord

Nothing breaks, by design. Assignment points at **`User`**, not at a Discord
account: the card prints their name whether or not `User.discordId` is set, and
they still get the existing assignment email and the crew portal. Discord is a
second window onto the assignment, never the record of it.

## What needs your approval before it is built

### 1. Let a 🚚 Crew Lead press the move-day buttons  *(authorization change)*

Today **Start Job / Complete Job / Arrived / Waiting / Customer Ready** are all in
`OWNER_ACTIONS` — owner-only, fail-closed. A Crew Lead sees the buttons on the
crew card and gets "🔒 You do not have permission".

Proposed: a second, narrower gate — `CREW_ACTIONS` = those five buttons only —
allowed for the owner allowlist **or** a holder of a new `DISCORD_CREW_LEAD_ROLE_ID`.
`approve_booking`, `deny_booking`, `offer_reschedule`, `view_full_booking` and
`archive_job` stay owner-only and untouched.

Why this needs a decision and was not done silently: **the waiting-time buttons
set a fee.** `waiting_end` persists `waitingFee` on the booking. Handing that to a
role is handing someone the ability to charge a customer.

- *Stricter option:* require the presser to be the **assigned** lead for *that*
  job — `User.discordId` matches and their `JobCrew` row is live with
  `role = CREW_LEADER`. Costs one query per press; means a lead cannot touch
  another crew's job.
- *Files:* `app/api/discord/interactions/route.ts`, `src/lib/discord-auth.ts`,
  `src/lib/env.ts`. **Schema: none.**
- *Rollback:* unset `DISCORD_CREW_LEAD_ROLE_ID` — the gate fails closed to owners.
- *Tests:* a Crew Lead can start a job; a Crew Lead cannot approve, deny or view a
  full booking; a Mover can do none of it; an unset role id means owners only.

### 2. Put the street address on the crew card on move day  *(privacy change)*

The crew card shows **city and state only**, exactly as specified, and carries no
navigation link — a maps link would put the street address into a channel every
mover can read, for every job, forever.

A crew cannot drive to "Orange, NJ". Today the owner has to pass the address on
by hand. Proposed: from **6:00 PM the evening before** until the job is
COMPLETED, the crew card gains the pickup and drop-off street address and an
*Open Navigation* button; on completion the card is repainted without them.
Because the card is one living message, the address does not pile up in channel
history — it appears, is used, and is removed.

- *Files:* `src/lib/job-cards.ts` (`toCrewView` gains a time-boxed `address`),
  plus a sync trigger at 6:00 PM (the 7:00 PM digest already repaints every card
  it lists, so moving that one hour earlier would do it).
- **Schema: none.** *Rollback:* revert the renderer; the next sync removes it.
- *Tests:* no address at T-2 days; address present the evening before; address
  absent again once COMPLETED; never present on a CANCELLED job.

### 3. Map Discord roles onto `User.role`  *(no change proposed yet)*

`User.role` is `OWNER | MANAGER | CREW`; Discord now has 👑 Owner, 🧭 Manager,
🚚 Crew Lead, 📦 Mover. They are maintained by hand in two places. That is fine
at three members. Worth automating only once inviting crew becomes routine:
on join, look the member up by `User.discordId` and grant the matching role.
Needs the privileged **Server Members** gateway intent and **Manage Roles** on
the bot — a real widening of what the bot can do, so it is not proposed now.

## Deliberately not proposed

- **Assigning crew from Discord.** The admin enforces things a slash command
  would have to re-implement: no deactivated worker, no double assignment, a rate
  must exist, a frozen rate snapshot, overlap warnings. One write path is what
  keeps payroll correct.
- **A new crew table of any kind.** `JobCrew` is the canonical labor record and
  `profit.ts` reads it and nothing else. A second assignment model would be a
  second answer to "what did labor cost on this move" — the exact collision
  `docs/admin/discord-crew-integration.md` was written to prevent.
