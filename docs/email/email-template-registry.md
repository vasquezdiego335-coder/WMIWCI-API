# Template registry

_Last updated 2026-07-21._ Source: `src/lib/email-registry.ts`.
Admin: `/admin/email-marketing/templates`.

23 registered templates. Every entry derives its class, truthful booking states
and required fields from the modules that own them; the registry adds the
trigger, the stop rules and `wiring`.

## `wiring` — a file is not a feature

| Value | Meaning |
|---|---|
| `wired` | A production code path sends it. |
| `flag-gated` | Wired, but an environment flag decides whether it ever fires. |
| `manual` | Only sent when an operator triggers it. |

`email-archive/` holds nine legacy React templates no send path can reach. They
are **absent** from the registry rather than listed as active, and a test
asserts no entry points into that directory.

## Conformance

`src/lib/__tests__/email-registry.test.ts` reads the worker's
`ALLOWED_TEMPLATES` as source text (that file cannot be imported — see
[admin-email-integration.md](./admin-email-integration.md)) and fails the build
if a sendable template has no registry entry, or a registry entry names a
template nothing can send.

`src/lib/__tests__/email-admin-features.test.ts` additionally asserts that
`email-render.ts` can render every template the worker can send — otherwise a
template would be sendable but not previewable or testable.
