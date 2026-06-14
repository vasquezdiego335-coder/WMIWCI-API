# ── Railway worker host ($5 plan) — ONE combined process ──
# Runs the BullMQ workers + the outbox email poller + the Discord bot together
# in a single container (cheapest RAM/CPU). The Next.js API stays on Vercel and
# is never run here. Railway should create ONE service with this start command.
#
# Without this process running in production: no emails, no SMS, and the Discord
# approval card never posts → paid bookings stall at PENDING_APPROVAL.
worker: npm run host:start
