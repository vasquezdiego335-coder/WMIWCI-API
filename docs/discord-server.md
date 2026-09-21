# The Move It Clear It Discord server

Restructured 2026-09-20 from 40 unprotected channels into a role-gated operations
server. This is the reference for how it is laid out, who sees what, which
variable feeds which channel, and how to check it is still correct.

**Check the live server against this document at any time:**

```bash
npx tsx scripts/discord-permission-audit.ts   # read-only: who can see what
npx tsx scripts/discord-post-check.ts         # can the bot still post everywhere?
```

Run the first one after **any** change to a role, channel or permission, and
before **every** crew invite.

## Layout

| Category | Channel | Fed by | Who sees it |
| --- | --- | --- | --- |
| 📌 START HERE | `#welcome` `#announcements` `#crew-guide` | people | everyone (read-only) |
| 🚚 OPERATIONS | `#today-jobs` | 7:00 AM ET digest | Mover, Crew Lead, Manager, Owner |
| | `#upcoming-jobs` | 7:00 PM ET digest | 〃 |
| | `#job-data` | one living crew card per confirmed job | 〃 |
| | `#crew-chat` `#job-photos` | people | 〃 (can post) |
| 💰 BUSINESS | `#bookings` | booking requests → owner job cards | Manager, Owner |
| | `#payments` | confirmed deposit-link payments | 〃 |
| | `#leads` | leads + contact-form messages | 〃 |
| | `#alerts` | payment failures, disputes, ops health | 〃 |
| | `#marketing` | QR-tracker webhook (other repo) + campaign notices | 〃 |
| 🛠 MANAGEMENT | `#admin` `#owner-tasks` | people / task commands | Owner |
| 🗄 ARCHIVE | everything from the old layout | — | Owner |

Nothing was deleted. `#bookings`, `#payments`, `#leads`, `#alerts`, `#marketing`,
`#admin`, `#owner-tasks` and `#today-jobs` are the **original channels, renamed
or moved — their IDs did not change**, which is why no notification broke.

`#upcoming-jobs` and `#job-data` are new on purpose: the channels they replace
(`#tomorrow-jobs`, `#🚚-jobs`) hold months of cards with customers' full names,
phone numbers, street addresses and labor prices, and could not be shown to crew.

## Roles

| Role | Sees | Notes |
| --- | --- | --- |
| 👑 Owner | everything | Administrator. **Same role ID as the old `admins`**, so `DISCORD_OWNER_ROLE_ID` needed no change. |
| 🧭 Manager | Start Here, Operations, Business | **Holding this role approves nothing.** Booking approval and the $49 capture are decided by `DISCORD_OWNER_USER_IDS` / `DISCORD_OWNER_ROLE_ID` in `src/lib/discord-auth.ts`, not by Discord permissions. |
| 🚚 Crew Lead | Start Here, Operations | Same view as a Mover today. See `discord-crew-assignment-proposal.md` §1. |
| 📦 Mover | Start Here, Operations | Reads the three job boards; posts only in `#crew-chat` and `#job-photos`. |
| *(no role)* | Start Here | A new member lands somewhere readable until they are given a role. |

All four new roles carry **no permissions of their own**. Access comes entirely
from channel overwrites, so a role can never grant more than its channels do.

`@everyone` no longer holds **Create Invite**, **Mention @everyone** or **Use
Application Commands**. The last one matters: `/job`, `/stats` and `/schedule`
print booking data, and a channel restriction does not stop a slash command.
(The commands are now also owner-gated in code — see `command-handler.ts`.)

### Two rules that keep it safe

1. **A channel's own overwrites are what count — not its category's.** Dragging a
   channel into 💰 BUSINESS does *not* hide it unless you also click *Sync
   permissions*. The audit script checks channels, not categories, for exactly
   this reason.
2. **Anything the policy does not name is treated as ARCHIVE** and must be
   invisible to crew. A new channel therefore fails the audit until it is either
   added to `src/lib/discord-permissions.ts` or locked down.

## Variables → channels

Identical on both Railway services (`wonderful-strength` and `discord workers`).

| Variable | Channel | Audience |
| --- | --- | --- |
| `DISCORD_CHANNEL_SCHEDULING` | `#bookings` | owner |
| `DISCORD_PAYMENTS_CHANNEL_ID` | `#payments` | owner — **now explicit**; it used to rely on an ID hard-coded in `deposit-notify.ts` |
| `DISCORD_CHANNEL_LEADS` | `#leads` | owner |
| `DISCORD_CHANNEL_OPERATIONS` | `#leads` | owner — was the **guild ID** by mistake, so contact-form messages fell through |
| `DISCORD_CHANNEL_NEWS` | `#leads` | owner (a fallback that never fires while LEADS is set) |
| `DISCORD_CHANNEL_ALERTS` | `#alerts` | owner |
| `DISCORD_CHANNEL_BOT_LOGS` | `#alerts` | owner — read by nothing; pointed here so no variable aims into the archive |
| `DISCORD_CHANNEL_MARKETING` | `#marketing` | owner — was missing on the worker |
| `DISCORD_CHANNEL_TODAY_JOBS` | `#today-jobs` | **crew** |
| `DISCORD_CHANNEL_UPCOMING_JOBS` | `#upcoming-jobs` | **crew** |
| `DISCORD_CHANNEL_JOB_DATA` | `#job-data` | **crew** — unset means crew cards are skipped, never misplaced |
| `DISCORD_CHANNEL_JOBS` | archived `#🚚-jobs` | legacy — read only by the retired job card; leave it where it is |

Anything pointed at a **crew** channel must carry only crew-safe content. Both
digests fall back to `DISCORD_CHANNEL_SCHEDULING` when their own variable is
unset — the safe direction: crew-safe content may reach owners, never the reverse.

`DISCORD_CHANNEL_PAYMENTS`, `_RECEIPTS`, `_PAPERWORK` and `_PHOTOS` are set on
both services and **read by no code** (they appear only in a start-up banner).
They can be deleted whenever convenient.

## What one booking looks like now

```
website checkout ($49 AUTHORIZED — capture_method 'manual', no money received)
   └─ #bookings   🟠 BOOKING REQUEST · $49 authorized · awaiting approval   [Approve] [Offer] [Deny]
                  (crew are told nothing: a request is not a job)

owner presses Approve → stripe.capture() OK → commitApproval() OK
   ├─ #bookings   the SAME message becomes  🟢 JOB CONFIRMED · $49 captured
   └─ #job-data   crew card CREATED         🟢 CONFIRMED

Start Job / Complete Job / crew assigned / date changed
   └─ both messages are EDITED in place — never re-posted
```

"JOB CONFIRMED" can originate from exactly one place: the approval notifier in
`booking-approval.ts`, which runs only after the capture succeeded **and** the
approval committed. A failed capture returns earlier with the claim rolled back.
`checkout.session.completed` cannot produce it — for this checkout it proves an
authorization, not a payment.

The deposit-**link** flow (`DepositRequest`) is separate and unchanged: that one
*is* a real immediate charge, verified by amount and currency, and announced
exactly once in `#payments`.

## Going live with the code in this change

The Discord server and the Railway variables are **already live**. The code is not.
Until it deploys, production keeps posting the old-format cards — into owner-only
channels, so nothing is exposed.

1. **Apply the migration** — `20260920120000_booking_discord_cards` (one new
   table, additive, no existing table touched). Use the Neon **direct** host, not
   the pooler (DEPLOY.md §10). Either order is *safe* — before the table exists
   the card sync logs "table missing" and posts nothing — but cards only start
   appearing once it is there.
2. **Merge and let both services deploy.**
3. **Then, and only then, set `DISCORD_CHANNEL_JOB_DATA` → `#job-data`** on both
   services. The crew card reads this NEW variable on purpose: the retired job
   card (full name, phone, street addresses, labor price) read
   `DISCORD_CHANNEL_JOBS`, so that one must never point at a crew channel. Until
   the new variable is set, crew cards are skipped rather than created in the
   wrong place; the next sync after it is set creates them in `#job-data`.
4. `npx tsx scripts/discord-post-check.ts`, then approve a test booking and watch
   the `#bookings` message turn green and a crew card appear in `#job-data`.

## Still to do by hand

- **Remove Administrator from the bot.** Discord will not let a bot edit its own
  highest role (the API answers `50013`), so only the server owner can: *Server
  Settings → Roles → Moving Final Bot → Permissions* — turn **Administrator** off
  and leave on **View Channels, Send Messages, Embed Links, Read Message History,
  Use Application Commands**. Then run `discord-post-check.ts`. The audit has
  already simulated this and every destination passes.
- **Drag the roles into order** (Owner, Manager, Crew Lead, Mover) — cosmetic; the
  bot cannot sort roles at or above its own position.
- **Write `#crew-guide`.** It is empty: company rules are yours to write.

## Rollback

Channel IDs never changed, so reverting the *server* is renames and moves only.
A BEFORE snapshot (every channel's name, category, topic and overwrites) was
saved, with a dry-run-first script that restores all 38 affected channels and
both roles. It deletes nothing. The Railway side is four values: unset
`DISCORD_PAYMENTS_CHANNEL_ID`, and put `DISCORD_CHANNEL_OPERATIONS`,
`DISCORD_CHANNEL_MARKETING` back (the old values were wrong, so there is little
reason to).
