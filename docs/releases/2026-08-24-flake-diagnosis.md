# The `quote-snapshot-notifications` flake — diagnosed and removed

## What was flaky

    not ok - a conflicting estimatedValue loses to the frozen snapshot everywhere
    src/lib/__tests__/quote-snapshot-notifications.test.ts

Observed once in four full-suite runs on 2026-08-23. The test passed in
isolation every time it was tried, which is what made it look mysterious.

## The cause — structural, not environmental

The assertion serialised the ENTIRE Discord card and searched the blob for a
three-character substring:

```js
const rich = JSON.stringify(buildLeadCard({ ... }))
assert.ok(!rich.includes('879'))
```

`buildLeadCard` stamps the card with `timestamp: new Date().toISOString()`
(`src/lib/booking-display.ts:497`). An ISO-8601 timestamp ends in a
three-digit millisecond field, so roughly one run in a thousand produces a
card containing the characters `879` for reasons that have nothing to do with
pricing. The test then failed, and the failure read as a pricing regression.

It was also weaker than it looked in the other direction: a blob search would
have passed if `$879` had appeared under some other label, and would fail on
any unrelated field that happened to contain those digits.

## The fix

Read the field the assertion is actually about. `buildLeadCard` puts the
amount in a field named `💵 Estimate`; the test now locates that field and
asserts on its value alone:

- contains `$779`
- does not contain `$879`
- says `package subtotal`
- says transportation is pending

A separate assertion pins the timestamp's continued presence, so nobody
"fixes" a future flake by deleting the timestamp instead of the blob search.

## Correction to the previous note

The V7 bundle offered a hypothesis that several suites sharing
`QUOTE_LEAD_CAPTURE_ENABLED` / `PARTIAL_BOOKING_EMAIL_CAPTURE_ENABLED` and the
`__setQuoteCaptureRouteDeps` seam might interleave if the runner ever executed
two of them in one process.

**That hypothesis is withdrawn.** No evidence was ever produced for it, and it
is not the cause. The failing test touches neither of those environment
variables nor that seam. It was speculation recorded as a lead, and leaving it
in place would send the next person to the wrong part of the codebase.

## Verification

- The repaired test: **50 consecutive runs, 50 passed, 0 failed**
  (`gates/10-flaky-50-runs.txt`).
- The full paired suite at normal concurrency: **3 consecutive runs,
  2775/2775 each, 0 skipped, 0 todo** (`gates/06-three-full-runs.txt`).

Concurrency was NOT pinned and no run was discarded. Every result is recorded.
