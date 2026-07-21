// EMAIL ADMIN FEATURES (owner spec 2026-07-21) — test send, campaigns,
// audiences, journey configuration, automations, the campaign relation.
//
// Every test here is offline and pure. What is asserted is the SAFETY of each
// feature, not its happy path: the audience builder refusing an unknown filter
// matters more than it accepting a known one, because the failure mode of all
// of this is mailing the wrong people.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  validateAudienceDefinition,
  SEGMENTS,
  FILTERS,
  MAX_AUDIENCE,
} from '../email-audience'
import {
  validateCampaign,
  canTransition,
  canApprove,
  allowedTransitions,
  SENDING_STATES,
  type CampaignState,
  type CampaignValidation,
} from '../email-campaign'
import {
  validateJourneyConfig,
  defaultConfig,
  effectiveConfig,
  diffFromDefaults,
  STOP_RULES,
  LOCKED_STOP_RULES,
  MIN_DELAY_MS,
} from '../email-journey-config'
import {
  validateAutomationDefinition,
  canTransitionAutomation,
  canActivate,
  automationJobId,
  APPROVED_TRIGGERS,
} from '../email-automation'
import { checkTestRecipient, syntheticPayload, checkRequiredVariables, TEST_SUBJECT_PREFIX } from '../email-test-send'
import { RENDERERS, renderableTemplates } from '../email-render'
import { can, EMAIL_BETA_OWNER_ONLY, EMAIL_MARKETING_BETA, type Action } from '../permissions'
import { templateRegistry } from '../email-registry'

const SRC = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

// ════════════════════════════════════════════════════════════════════
//  AUDIENCE BUILDER — the closed vocabulary
// ════════════════════════════════════════════════════════════════════

test('every approved segment validates', () => {
  for (const segment of Object.keys(SEGMENTS)) {
    const filters = segment === 'reengagement_eligible' ? { inactiveDays: 180 } : {}
    const v = validateAudienceDefinition({ segment, filters })
    assert.equal(v.ok, true, `approved segment ${segment} was rejected`)
  }
})

test('an unknown segment is rejected', () => {
  const v = validateAudienceDefinition({ segment: 'everyone', filters: {} })
  assert.equal(v.ok, false)
})

test('RAW SQL is not a segment, a filter, or anything else', () => {
  // The point is not that this specific string is blocked — it is that there is
  // no field in the schema where a query could go at all.
  for (const attempt of [
    { segment: "SELECT * FROM customers", filters: {} },
    { segment: 'completed_customers', filters: { where: "1=1; DROP TABLE bookings" } },
    { segment: 'completed_customers', filters: { sql: 'SELECT email FROM customers' } },
    { segment: 'completed_customers', filters: { $queryRaw: 'anything' } },
  ]) {
    const v = validateAudienceDefinition(attempt)
    assert.equal(v.ok, false, `this was accepted: ${JSON.stringify(attempt)}`)
  }
})

test('an unknown filter is REJECTED, never silently ignored', () => {
  // Dropping it would let an owner believe their audience is narrower than the
  // one that actually sends.
  const v = validateAudienceDefinition({ segment: 'completed_customers', filters: { madeUpKey: 'x' } })
  assert.equal(v.ok, false)
  if (!v.ok) assert.match(v.errors.join(' '), /Unknown filter/)
})

test('filter values are type-checked, not merely present', () => {
  assert.equal(validateAudienceDefinition({ segment: 'completed_customers', filters: { locale: 'fr' } }).ok, false)
  assert.equal(validateAudienceDefinition({ segment: 'completed_customers', filters: { originZip: 'not-a-zip' } }).ok, false)
  assert.equal(validateAudienceDefinition({ segment: 'completed_customers', filters: { serviceType: 'Mansion' } }).ok, false)
  assert.equal(validateAudienceDefinition({ segment: 'completed_customers', filters: { movedAfter: 'yesterday' } }).ok, false)
  assert.equal(validateAudienceDefinition({ segment: 'completed_customers', filters: { locale: 'es' } }).ok, true)
})

test('re-engagement requires an inactivity window', () => {
  assert.equal(validateAudienceDefinition({ segment: 'reengagement_eligible', filters: {} }).ok, false)
  assert.equal(validateAudienceDefinition({ segment: 'reengagement_eligible', filters: { inactiveDays: 90 } }).ok, true)
})

test('an inverted date range is rejected', () => {
  const v = validateAudienceDefinition({
    segment: 'completed_customers',
    filters: { movedAfter: '2026-06-01T00:00:00.000Z', movedBefore: '2026-01-01T00:00:00.000Z' },
  })
  assert.equal(v.ok, false)
})

test('every audience query is bounded', () => {
  // An unbounded scan behind a web form is how an admin page takes the database
  // down. The cap is asserted here AND in the source.
  assert.ok(MAX_AUDIENCE > 0 && MAX_AUDIENCE <= 20000)
  const src = read('lib/email-audience.ts')
  const takes = src.match(/take[,:]/g) ?? []
  assert.ok(takes.length > 0, 'no `take` bound found in the audience queries')
  assert.equal(/\$queryRaw|\$executeRaw/.test(src), false, 'the audience builder must never use a raw query')
})

test('the builder never interpolates a value into a query string', () => {
  const src = read('lib/email-audience.ts')
  assert.equal(/`[^`]*SELECT[^`]*\$\{/i.test(src), false, 'string-built SQL found')
})

// ════════════════════════════════════════════════════════════════════
//  CAMPAIGN LIFECYCLE
// ════════════════════════════════════════════════════════════════════

const goodSpec = {
  name: 'Summer re-engagement',
  sourceKey: 'summer-reengagement',
  template: 'review-request',
  audienceDefinition: { segment: 'completed_customers', filters: {} },
}

test('a campaign can NEVER go straight from draft to sending', () => {
  for (const target of SENDING_STATES) {
    assert.equal(canTransition('DRAFT', target).ok, false, `DRAFT → ${target} was allowed`)
  }
  assert.equal(canTransition('DRAFT', 'ACTIVE').ok, false)
})

test('the approval path is validate → ready → scheduled → active', () => {
  assert.equal(canTransition('DRAFT', 'VALIDATING').ok, true)
  assert.equal(canTransition('VALIDATING', 'READY').ok, true)
  assert.equal(canTransition('READY', 'SCHEDULED').ok, true)
  assert.equal(canTransition('SCHEDULED', 'ACTIVE').ok, true)
})

test('pause, resume and cancel are supported; archived is terminal', () => {
  assert.equal(canTransition('ACTIVE', 'PAUSED').ok, true)
  assert.equal(canTransition('PAUSED', 'ACTIVE').ok, true)
  assert.equal(canTransition('SCHEDULED', 'CANCELLED').ok, true)
  assert.deepEqual(allowedTransitions('ARCHIVED'), [])
})

test('a completed campaign cannot be re-run — that would rewrite history', () => {
  assert.equal(canTransition('COMPLETED', 'ACTIVE').ok, false)
  assert.equal(canTransition('COMPLETED', 'DRAFT').ok, false)
})

test('a campaign requires a template, a source key and an audience', () => {
  assert.equal(validateCampaign({ ...goodSpec, audienceDefinition: null }).ok, false)
  assert.equal(validateCampaign({ ...goodSpec, sourceKey: '' }).ok, false)
  assert.equal(validateCampaign({ ...goodSpec, template: 'not-a-template' }).ok, false)
})

test('a TRANSACTIONAL template can never be broadcast to an audience', () => {
  // A receipt states that a specific person paid. Sending it to a list tells
  // people about payments that did not happen.
  const v = validateCampaign({ ...goodSpec, template: 'payment-receipt' })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /TRANSACTIONAL/i)
})

test('an invalid source key is rejected before it reaches attribution', () => {
  assert.equal(validateCampaign({ ...goodSpec, sourceKey: 'has spaces & symbols!' }).ok, false)
})

test('a campaign scheduled in the past is rejected', () => {
  const v = validateCampaign({ ...goodSpec, scheduledAt: new Date(Date.now() - 86_400_000).toISOString() })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /past/i)
})

test('approval requires a PASSING and RECENT validation', () => {
  const passing: CampaignValidation = { ok: true, errors: [], warnings: [], checkedAt: new Date().toISOString() }
  const failing: CampaignValidation = { ok: false, errors: ['no audience'], warnings: [], checkedAt: new Date().toISOString() }
  const stale: CampaignValidation = { ok: true, errors: [], warnings: [], checkedAt: new Date(Date.now() - 48 * 3_600_000).toISOString() }

  assert.equal(canApprove('VALIDATING', passing).ok, true)
  assert.equal(canApprove('VALIDATING', failing).ok, false)
  assert.equal(canApprove('VALIDATING', null).ok, false)
  // A pass from two days ago describes a campaign that may no longer exist.
  assert.equal(canApprove('VALIDATING', stale).ok, false)
  assert.equal(canApprove('DRAFT', passing).ok, false)
})

test('the API creates DRAFT campaigns only', () => {
  // The single most dangerous possible regression: a create endpoint that
  // accepts a status. Asserted against the source.
  const src = readFileSync(join(SRC, '..', 'app', 'api', 'admin', 'email-marketing', 'campaigns', 'route.ts'), 'utf8')
  assert.ok(src.includes("status: 'DRAFT'"), 'campaign creation no longer forces DRAFT')
  assert.equal(/CreateSchema[\s\S]{0,800}status:\s*z\./.test(src), false, 'the create schema accepts a status')
})

// ════════════════════════════════════════════════════════════════════
//  JOURNEY CONFIGURATION
// ════════════════════════════════════════════════════════════════════

test('the safe defaults are valid for every journey', () => {
  for (const key of ['abandoned', 'quote', 'post-job', 'pre-move', 'booking', 'lead-intake']) {
    const d = defaultConfig(key)
    assert.ok(d, `no defaults for ${key}`)
    const v = validateJourneyConfig(key, d)
    assert.equal(v.ok, true, `the DEFAULTS for ${key} do not validate: ${!v.ok ? v.errors.join(' ') : ''}`)
  }
})

test('an IMMEDIATE transactional stage cannot be given a delay', () => {
  // A confirmation or receipt fires the moment its event happens. Allowing a
  // delay here would let an owner make a receipt arrive five minutes after the
  // payment, which reads to a customer as a broken system.
  const d = defaultConfig('booking')!
  const delayed = validateJourneyConfig('booking', {
    ...d,
    stages: d.stages.map((s) => ({ ...s, delayMs: 30 * 60_000 })),
  })
  assert.equal(delayed.ok, false)
  if (!delayed.ok) assert.match(delayed.errors.join(' '), /cannot be delayed/i)

  // And it stays valid at zero.
  assert.equal(validateJourneyConfig('booking', d).ok, true)
})

test('an instant-fire delay is rejected on a FOLLOW-UP stage', () => {
  const d = defaultConfig('abandoned')!
  const v = validateJourneyConfig('abandoned', { ...d, stages: d.stages.map((s) => ({ ...s, delayMs: 0 })) })
  assert.equal(v.ok, false)
})

test('a delay beyond the maximum is rejected', () => {
  const d = defaultConfig('abandoned')!
  const v = validateJourneyConfig('abandoned', {
    ...d,
    stages: d.stages.map((s, i) => ({ ...s, delayMs: (i + 1) * 400 * 24 * 3_600_000 })),
  })
  assert.equal(v.ok, false)
})

test('stages must move forward in time', () => {
  const d = defaultConfig('quote')!
  const v = validateJourneyConfig('quote', {
    ...d,
    stages: [
      { ...d.stages[0], delayMs: 5 * 24 * 3_600_000 },
      { ...d.stages[1], delayMs: 2 * 24 * 3_600_000 },
      d.stages[2],
    ],
  })
  assert.equal(v.ok, false)
})

test('a stage type the worker does not dispatch is rejected', () => {
  const d = defaultConfig('abandoned')!
  const v = validateJourneyConfig('abandoned', { ...d, stages: [{ type: 'invented-stage', template: 'referral', delayMs: MIN_DELAY_MS * 2 }] })
  assert.equal(v.ok, false)
})

test('an unregistered template is rejected', () => {
  const d = defaultConfig('abandoned')!
  const v = validateJourneyConfig('abandoned', { ...d, stages: [{ ...d.stages[0], template: 'made-up' }] })
  assert.equal(v.ok, false)
})

test('locked stop rules are forced ON even when submitted as false', () => {
  const d = defaultConfig('abandoned')!
  const off = Object.fromEntries(Object.keys(STOP_RULES).map((k) => [k, false]))
  const v = validateJourneyConfig('abandoned', { ...d, stopRules: off })
  assert.equal(v.ok, true)
  if (v.ok) {
    for (const locked of LOCKED_STOP_RULES) {
      assert.equal(v.config.stopRules[locked], true, `${locked} was allowed to be turned off`)
    }
    // A non-locked rule keeps what was asked for.
    assert.equal(v.config.stopRules.stopAfterBooking, false)
  }
})

test('an unknown stop rule is rejected', () => {
  const d = defaultConfig('abandoned')!
  const v = validateJourneyConfig('abandoned', { ...d, stopRules: { ...d.stopRules, stopWheneverIFeelLikeIt: true } })
  assert.equal(v.ok, false)
})

test('a stored configuration that is INVALID degrades to the safe defaults', () => {
  // The scenario: someone edits the row directly and sets every delay to zero.
  // The journey must NOT produce an instant burst — it must ignore the row.
  const effective = effectiveConfig('abandoned', {
    enabled: true,
    version: 7,
    config: { enabled: true, respectQuietHours: true, stages: [{ type: 'abandoned-checkout-recovery', template: 'abandoned-checkout', delayMs: 0 }], stopRules: {}, caps: {} },
  })
  assert.ok(effective)
  assert.equal(effective!.source, 'defaults', 'an invalid stored config was allowed to run')
  assert.ok(effective!.degradedReason, 'the degradation was not explained')
  // The version is preserved so the row can still be found and fixed.
  assert.equal(effective!.version, 7)
})

test('no stored row means the code defaults, not an empty config', () => {
  const effective = effectiveConfig('abandoned', null)
  assert.equal(effective!.source, 'defaults')
  assert.equal(effective!.degradedReason, null)
  assert.equal(effective!.version, 0)
  assert.ok(effective!.config.stages.length > 0)
})

test('a valid stored configuration is used, and its version is reported', () => {
  const d = defaultConfig('abandoned')!
  const effective = effectiveConfig('abandoned', { enabled: true, version: 3, config: d })
  assert.equal(effective!.source, 'database')
  assert.equal(effective!.version, 3)
})

test('a disabled row disables the journey even if the config says enabled', () => {
  const d = defaultConfig('abandoned')!
  const effective = effectiveConfig('abandoned', { enabled: false, version: 2, config: { ...d, enabled: true } })
  assert.equal(effective!.config.enabled, false)
})

test('the diff names what an owner changed', () => {
  const d = defaultConfig('abandoned')!
  const changed = { ...d, caps: { perRecipientPerMonth: 2 }, respectQuietHours: false }
  const diff = diffFromDefaults('abandoned', changed)
  assert.ok(diff.some((x) => /quiet hours/i.test(x)))
  assert.ok(diff.some((x) => /cap/i.test(x)))
})

// ════════════════════════════════════════════════════════════════════
//  AUTOMATIONS
// ════════════════════════════════════════════════════════════════════

const goodAutomation = {
  trigger: 'review_eligible',
  audience: { segment: 'review_eligible', filters: {} },
  stages: [{ key: 'stage-1', template: 'review-request', delayMs: 24 * 3_600_000 }],
  stopRules: {},
  caps: { perRecipientPerMonth: 1 },
  respectQuietHours: true,
  maxStages: 3,
}

test('every approved trigger is accepted', () => {
  for (const trigger of Object.keys(APPROVED_TRIGGERS)) {
    const v = validateAutomationDefinition({ ...goodAutomation, trigger })
    assert.equal(v.ok, true, `approved trigger ${trigger} was rejected`)
  }
})

test('an unapproved trigger is rejected', () => {
  assert.equal(validateAutomationDefinition({ ...goodAutomation, trigger: 'whenever_i_want' }).ok, false)
  assert.equal(validateAutomationDefinition({ ...goodAutomation, trigger: null }).ok, false)
})

test('an automation cannot send a transactional template', () => {
  const v = validateAutomationDefinition({
    ...goodAutomation,
    stages: [{ key: 'a', template: 'payment-receipt', delayMs: 24 * 3_600_000 }],
  })
  assert.equal(v.ok, false)
  if (!v.ok) assert.match(v.errors.join(' '), /transactional/i)
})

test('an automation cannot exceed its own stage limit', () => {
  const v = validateAutomationDefinition({
    ...goodAutomation,
    maxStages: 1,
    stages: [
      { key: 'a', template: 'review-request', delayMs: 3_600_000 * 24 },
      { key: 'b', template: 'referral', delayMs: 3_600_000 * 48 },
    ],
  })
  assert.equal(v.ok, false)
})

test('automation stages must move forward and have unique keys', () => {
  assert.equal(
    validateAutomationDefinition({
      ...goodAutomation,
      stages: [
        { key: 'a', template: 'review-request', delayMs: 48 * 3_600_000 },
        { key: 'b', template: 'referral', delayMs: 24 * 3_600_000 },
      ],
    }).ok,
    false
  )
  assert.equal(
    validateAutomationDefinition({
      ...goodAutomation,
      stages: [
        { key: 'same', template: 'review-request', delayMs: 24 * 3_600_000 },
        { key: 'same', template: 'referral', delayMs: 48 * 3_600_000 },
      ],
    }).ok,
    false
  )
})

test('an automation audience must be an approved segment', () => {
  assert.equal(validateAutomationDefinition({ ...goodAutomation, audience: { segment: 'anyone', filters: {} } }).ok, false)
  // Omitting the audience entirely is fine — the trigger is the audience.
  assert.equal(validateAutomationDefinition({ ...goodAutomation, audience: null }).ok, true)
})

test('locked stop rules cannot be disabled on an automation either', () => {
  const off = Object.fromEntries(Object.keys(STOP_RULES).map((k) => [k, false]))
  const v = validateAutomationDefinition({ ...goodAutomation, stopRules: off })
  assert.equal(v.ok, true)
  if (v.ok) for (const locked of LOCKED_STOP_RULES) assert.equal(v.definition.stopRules[locked], true)
})

test('an automation must be rehearsed in TEST before it can go ACTIVE', () => {
  assert.equal(canTransitionAutomation('DRAFT', 'ACTIVE').ok, false)
  assert.equal(canTransitionAutomation('VALIDATING', 'ACTIVE').ok, false)
  assert.equal(canTransitionAutomation('TEST', 'ACTIVE').ok, true)
  assert.equal(canTransitionAutomation('PAUSED', 'ACTIVE').ok, true)
})

test('activation re-validates the stored definition', () => {
  assert.equal(canActivate({ state: 'TEST', activeVersion: 1, definition: goodAutomation }).ok, true)
  assert.equal(canActivate({ state: 'TEST', activeVersion: 1, definition: { trigger: 'nonsense' } }).ok, false)
  assert.equal(canActivate({ state: 'TEST', activeVersion: null, definition: goodAutomation }).ok, false)
  assert.equal(canActivate({ state: 'DRAFT', activeVersion: 1, definition: goodAutomation }).ok, false)
})

test('archived is terminal', () => {
  assert.equal(canTransitionAutomation('ARCHIVED', 'ACTIVE').ok, false)
  assert.equal(canTransitionAutomation('ARCHIVED', 'DRAFT').ok, false)
})

test('the job id carries the VERSION, so two versions cannot collide', () => {
  const v1 = automationJobId('auto1', 1, 'stage-1', 'booking9')
  const v2 = automationJobId('auto1', 2, 'stage-1', 'booking9')
  assert.notEqual(v1, v2, 'a new version would overwrite the previous version\'s queued job')
  // Same version + same subject IS the same job — that is the dedupe guarantee.
  assert.equal(v1, automationJobId('auto1', 1, 'stage-1', 'booking9'))
})

test('automation definitions are versioned, never edited in place', () => {
  const src = readFileSync(join(SRC, '..', 'app', 'api', 'admin', 'email-marketing', 'automations', 'route.ts'), 'utf8')
  assert.ok(src.includes('emailAutomationVersion.create'), 'saving no longer writes a new version row')
  assert.equal(/emailAutomationVersion\.update/.test(src), false, 'a version row is being MUTATED — versions must be immutable')
})

// ════════════════════════════════════════════════════════════════════
//  TEST SEND
// ════════════════════════════════════════════════════════════════════

test('a test send goes through the canonical guard, not around it', () => {
  const src = read('lib/email-test-send.ts')
  assert.ok(src.includes('guardedSend'), 'the test sender no longer uses guardedSend')
  assert.equal(/resend\s*\.\s*emails\s*\.\s*send/.test(src.replace(/\/\/.*$/gm, '')), false, 'the test sender calls the provider directly')
  assert.ok(src.includes('isTest: true'), 'test sends are no longer flagged on the ledger')
})

test('the test subject is prefixed so it is unmistakable in an inbox', () => {
  assert.equal(TEST_SUBJECT_PREFIX, '[TEST]')
})

test('a test cannot go to an arbitrary address without an explicit override', () => {
  const previous = process.env.EMAIL_TEST_RECIPIENT
  process.env.EMAIL_TEST_RECIPIENT = 'test@moveitclearit.com'
  try {
    // The configured address always works.
    const ok = checkTestRecipient('test@moveitclearit.com', false)
    assert.equal(ok.ok, true)
    if (ok.ok) assert.equal(ok.isOverride, false)

    // A different address WITHOUT the override is refused.
    const refused = checkTestRecipient('a.real.customer@gmail.com', false)
    assert.equal(refused.ok, false)

    // With the override it is allowed, and RECORDED as an override.
    const overridden = checkTestRecipient('a.real.customer@gmail.com', true)
    assert.equal(overridden.ok, true)
    if (overridden.ok) assert.equal(overridden.isOverride, true)
  } finally {
    if (previous === undefined) delete process.env.EMAIL_TEST_RECIPIENT
    else process.env.EMAIL_TEST_RECIPIENT = previous
  }
})

test('with no configured recipient, a bare test send is refused', () => {
  const previous = process.env.EMAIL_TEST_RECIPIENT
  delete process.env.EMAIL_TEST_RECIPIENT
  try {
    assert.equal(checkTestRecipient(null, false).ok, false)
    assert.equal(checkTestRecipient('someone@example.com', false).ok, false)
  } finally {
    if (previous !== undefined) process.env.EMAIL_TEST_RECIPIENT = previous
  }
})

test('synthetic data is obviously fake and satisfies every required field', () => {
  for (const t of templateRegistry()) {
    const payload = syntheticPayload(t.key, 'https://www.moveitclearit.com')
    const { missing } = checkRequiredVariables(t.key, payload)
    assert.deepEqual(missing, [], `${t.key} has unfilled required variables: ${missing.join(', ')}`)
  }
  const p = syntheticPayload('final-confirmation', 'https://www.moveitclearit.com')
  assert.match(String(p.customerName), /Test/i)
  assert.match(String(p.bookingReference), /TEST/i)
})

test('test sends are excluded from every marketing number', () => {
  // The ledger flag is only useful if the readers honour it.
  const attribution = read('lib/email-attribution.ts')
  assert.ok(attribution.includes('isTest: false'), 'attribution counts test sends')
  const admin = read('lib/email-admin.ts')
  assert.ok(admin.includes('isTest: false'), 'the overview counts test sends')
  const guard = read('lib/email-guard.ts')
  assert.ok(guard.includes('isTest: false'), 'the frequency cap counts test sends')
})

// ════════════════════════════════════════════════════════════════════
//  RENDERERS + CAMPAIGN RELATION
// ════════════════════════════════════════════════════════════════════

test('the admin renderer covers every template the worker can send', () => {
  const workerSrc = read('workers/email.worker.ts')
  const block = workerSrc.match(/const ALLOWED_TEMPLATES = new Set<[^>]*>\(\[([\s\S]*?)\]\)/)
  assert.ok(block)
  const allowed = Array.from(block![1].matchAll(/'([^']+)'/g)).map((m) => m[1])
  const missing = allowed.filter((k) => !RENDERERS[k])
  assert.deepEqual(missing, [], `these templates cannot be previewed or test-sent: ${missing.join(', ')}`)
})

test('every renderer key is a registered template', () => {
  const registered = new Set(templateRegistry().map((t) => t.key))
  const orphans = renderableTemplates().filter((k) => !registered.has(k))
  assert.deepEqual(orphans, [], `renderers exist for unregistered templates: ${orphans.join(', ')}`)
})

test('deleting a campaign preserves the email send record', () => {
  // A campaign is a marketing artifact; a send is a record that a real person
  // was written to. Losing the second to tidy up the first is not acceptable.
  const schema = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8')
  const emailSendBlock = schema.slice(schema.indexOf('model EmailSend'), schema.indexOf('model EmailEvent'))
  assert.ok(emailSendBlock.includes('onDelete: SetNull'), 'the campaign relation is no longer SET NULL')
  assert.equal(/campaignId[\s\S]{0,200}onDelete: Cascade/.test(emailSendBlock), false, 'campaign deletion would cascade to sends')
  assert.ok(emailSendBlock.includes('campaignId String?'), 'campaignId must stay NULLABLE for historical rows')
  assert.ok(emailSendBlock.includes('@@index([campaignId])'), 'campaignId is not indexed')
})

test('the legacy campaign string is kept for backward compatibility', () => {
  const schema = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8')
  const emailSendBlock = schema.slice(schema.indexOf('model EmailSend'), schema.indexOf('model EmailEvent'))
  assert.ok(/\n\s*campaign\s+String\?/.test(emailSendBlock), 'the legacy campaign string was removed')
})

test('reporting prefers the relation and falls back to the legacy string', () => {
  const src = read('lib/email-attribution.ts')
  assert.ok(src.includes('campaignId: c.id'), 'reporting no longer prefers the relation')
  assert.ok(src.includes('campaignId: null, campaign: c.sourceKey'), 'the legacy fallback was removed')
})

test('ambiguous historical rows are NOT backfilled', () => {
  // A source-key match is not proof of which campaign sent an email. Guessing
  // would fabricate attribution the reports then present as fact.
  const migration = readFileSync(
    join(SRC, '..', 'prisma', 'migrations', '20260721210000_email_marketing_admin', 'migration.sql'),
    'utf8'
  )
  assert.equal(/UPDATE\s+"?email_sends"?\s+SET\s+"?campaign_id"?/i.test(migration), false, 'the migration backfills campaign_id by guessing')
  assert.ok(/NO BACKFILL/i.test(migration), 'the deliberate no-backfill decision is no longer documented')
})

// ════════════════════════════════════════════════════════════════════
//  BETA PERMISSIONS
// ════════════════════════════════════════════════════════════════════

const ALL_EMAIL_ACTIONS: Action[] = [
  'email.view', 'email.view_recipients', 'email.view_attribution', 'email.manage_journey',
  'email.cancel_scheduled', 'email.retry_send', 'email.manage_suppression', 'email.manage_campaign',
  'email.send_test', 'email.configure',
]

test('BETA: the whole email section is owner-only', () => {
  assert.equal(EMAIL_MARKETING_BETA, true, 'the beta flag was cleared without updating this test')
  for (const a of ALL_EMAIL_ACTIONS) {
    assert.equal(can('OWNER', a), true, `OWNER denied ${a}`)
    assert.equal(can('MANAGER', a), false, `MANAGER can ${a} during Beta`)
    assert.equal(can('CREW', a), false, `CREW can ${a}`)
    assert.equal(can(null, a), false, `a signed-out visitor can ${a}`)
  }
})

test('the beta-only restrictions are named, so lifting them is a known edit', () => {
  // These three are the manager-operational set. Everything else stays
  // owner-only permanently, and this test records which is which.
  assert.deepEqual([...EMAIL_BETA_OWNER_ONLY].sort(), ['email.cancel_scheduled', 'email.send_test', 'email.view'])
})

test('Beta did not widen any Stage 4 financial permission', () => {
  for (const a of ['money.view_company_profit', 'closeout.finalize', 'distribution.approve', 'report.view_owner_money'] as Action[]) {
    assert.equal(can('MANAGER', a), false)
    assert.equal(can('OWNER', a), true)
  }
  // And it did not accidentally remove manager operations.
  assert.equal(can('MANAGER', 'action_center.view'), true)
  assert.equal(can('MANAGER', 'closeout.edit'), true)
})

test('every admin email API enforces permission on the server', () => {
  const base = join(SRC, '..', 'app', 'api', 'admin', 'email-marketing')
  for (const route of ['route.ts', 'sends/route.ts', 'scheduled/route.ts', 'suppressions/route.ts', 'test-send/route.ts', 'campaigns/route.ts', 'audiences/route.ts', 'journey-config/route.ts', 'automations/route.ts']) {
    const src = readFileSync(join(base, route), 'utf8')
    assert.ok(src.includes('denyReason('), `${route} does not check permissions`)
    assert.ok(src.includes('getSession'), `${route} does not read the session`)
    assert.ok(/status: 403/.test(src), `${route} never returns 403`)
  }
})
