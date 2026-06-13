# ── Persistent worker host (Railway / Render / Fly.io / a VPS) — NOT Vercel ──
# Vercel serves the Next.js API only; serverless CANNOT run these long-lived
# processes. If they are not running in production:
#   • outbox email_jobs are inserted but never sent (pile up as 'pending')
#   • SMS is never sent
#   • the Discord APPROVAL CARD never posts → bookings stall at PENDING_APPROVAL
#
# Deploy this repo to a persistent host and run all three process types. They
# share the same DATABASE_URL / REDIS_URL / Discord / Resend / Twilio env.
#
#   outbox-worker : booking emails (transactional-outbox poller, Postgres only)
#   workers       : SMS + Discord cards + scheduled digests (Redis-backed)
#   bot           : Discord gateway (slash commands + interaction acks)
outbox-worker: npm run outbox:start
workers: npm run workers:start
bot: npm run bot:start
