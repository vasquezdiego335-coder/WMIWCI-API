// Side-effect module: turn the lifecycle journeys ON *before* journeys.ts is
// loaded. `JOURNEYS_ENABLED` is a module-level const, read once at import, so
// setting the variable inside a test would be too late — the flag would already
// be false and every scheduling test would pass for the wrong reason.
//
// Import this FIRST in any test that exercises real scheduling. It is not a
// test file and is never listed in `npm test`.
process.env.EMAIL_JOURNEYS_ENABLED = 'true'
// A canary allowlist would block every scheduling assertion below. Tests that
// care about the canary set it themselves and restore it.
delete process.env.EMAIL_PROMOTIONAL_ALLOWLIST
export {}
