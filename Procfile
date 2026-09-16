# ── Railway worker host ($5 plan) — ONE combined process ──
# Runs BullMQ workers (including event-driven outbox drains), the recurring
# schedules and the Discord bot in a single container (cheapest RAM/CPU).
#
# HISTORICAL FILE. Railway's worker service ("discord workers", project
# patient-communication) sets its own start command in the UI, and the Next.js
# API is a SEPARATE Railway service ("wonderful-strength"). Nothing here is read
# at deploy time; the line below documents the command that service runs.
#
# Without that process running in production: no customer email is ever sent
# (the API only enqueues), and the Discord approval card never posts → paid
# bookings stall at PENDING_APPROVAL. Email is the only customer channel.
worker: npm run host:start
