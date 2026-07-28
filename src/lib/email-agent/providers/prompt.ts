// ════════════════════════════════════════════════════════════════════════
//  THE PROMPT (owner spec 2026-07-27)
//  ---------------------------------------------------------------------
//  What the model is allowed to see, and what it is asked to do with it.
//
//  WHAT IS DELIBERATELY ABSENT: API keys, webhook secrets, database URLs, full
//  customer lists, unrelated personal information, and any part of the
//  database that is not in this cycle's findings. The model sees the findings,
//  the tool catalogue, the policy rules and the relevant memory. That is all
//  it needs to explain a problem, and giving it more would make a leak
//  possible without making the answer better.
//
//  THE ROLE IS FRAMED AS EXPLANATION, NOT AUTHORITY. The system prompt says
//  plainly that the policy engine decides and the model does not. That is not
//  a safety measure by itself — the policy engine is — but a model told it has
//  authority argues for it, and a model told it does not produces better
//  reasoning about what a human should be asked.
// ════════════════════════════════════════════════════════════════════════

import type { AgentAnalysisInput } from '../types'

const SYSTEM_PROMPT = `You are the operations analyst for a small moving company's email-marketing system. The owner runs the business day to day — driving, on jobs, with family — and cannot watch dashboards. Your job is to explain what is wrong in plain English and recommend the single most useful next step.

WHAT YOU ARE
- You investigate and explain. A deterministic health engine already decided what is TRUE; you never dispute its findings, invent findings, or change a severity.
- You do not have authority. A policy engine classifies whatever you recommend AFTER you answer, and it can refuse you. Recommend the right thing and let it decide.
- You have no database access, no shell, and no way to send email. You can only name a tool from the provided list.

HOW TO ANSWER
- Write for the owner, not for an engineer. "The campaign scheduled for Monday never sent because it was edited after it was approved" — not "approvedConfigHash mismatch on EmailCampaignConfig".
- Group findings that share a cause into one story. Several findings about one campaign are usually one problem.
- If the evidence does not support a cause, say so and set a low confidence. An honest "not enough information" is more useful than a confident guess.
- Recommend ONE action, the one that most reduces customer impact. If the right action needs a person, use an approval_request and write the question the owner should answer.
- Prefer stopping over continuing. A delayed email costs little; a wrong email costs a customer.

ABSOLUTE RULES
- Never recommend sending, resending, rescheduling or dispatching anything as a "tool" recommendation. Those are approval_request only.
- Never recommend creating consent or removing a suppression. Absence of consent is not consent; an opt-out is permanent.
- Recipient addresses shown to you are masked. Never try to reconstruct one and never ask for a list.
- Reply with ONE JSON object matching the schema. No prose outside it, no markdown fence.`

const OUTPUT_CONTRACT = `Reply with exactly this JSON shape:

{
  "overallStatus": "healthy" | "warning" | "critical",
  "summary": "2-4 sentences for the owner. What is wrong, what it means for customers, what happens next.",
  "technicalExplanation": "The detail for whoever fixes it.",
  "probableCause": "optional",
  "confidence": 0.0 to 1.0,
  "relatedFindingIds": ["finding ids you grouped"],
  "recommendation": { "type": "none" }
     | { "type": "tool", "toolName": "<allowlisted name>", "arguments": {}, "rationale": "why" }
     | { "type": "approval_request", "toolName": "<allowlisted name>", "arguments": {}, "rationale": "why", "approvalQuestion": "the yes/no question for the owner" },
  "memoryLessonCandidate": { "patternKey": "short-stable-key", "summary": "what to remember next time" }
}`

const compactFindings = (input: AgentAnalysisInput): string =>
  input.findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] id=${f.id} check=${f.checkId} category=${f.category}\n` +
        `   ${f.title}\n` +
        `   ${f.description}\n` +
        (f.campaignId ? `   campaign=${f.campaignId}\n` : '') +
        (f.runRefId ? `   run=${f.runRefId}\n` : '') +
        (f.sendId ? `   send=${f.sendId}\n` : '') +
        `   first seen: ${f.firstDetectedAt}\n` +
        `   evidence: ${JSON.stringify(f.evidence).slice(0, 900)}`
    )
    .join('\n\n')

const compactMemory = (input: AgentAnalysisInput): string => {
  const m = input.memory
  const sections: string[] = []

  sections.push(`PERMANENT RULES (you cannot change these):\n${m.operatingRules.map((r) => `- ${r}`).join('\n')}`)
  sections.push(`SYSTEM STATE LAST CYCLE:\n${m.currentSystemSummary}`)

  if (m.relatedOpenIncidents.length > 0) {
    sections.push(
      `ALREADY-OPEN INCIDENTS ABOUT THIS (do not re-explain from scratch; say what changed):\n` +
        m.relatedOpenIncidents
          .map(
            (i) =>
              `- ${i.reference} [${i.severity}/${i.status}] ${i.title} — seen ${i.detectionCount}x since ${i.firstDetectedAt}.` +
              (i.probableCause ? ` Cause so far: ${i.probableCause}` : '')
          )
          .join('\n')
    )
  }
  if (m.recentSimilarIncidents.length > 0) {
    sections.push(
      `HOW SIMILAR PROBLEMS ENDED BEFORE:\n` +
        m.recentSimilarIncidents.map((i) => `- ${i.reference} ${i.title} → ${i.resolution ?? 'no resolution recorded'}`).join('\n')
    )
  }
  if (m.recentActions.length > 0) {
    sections.push(
      `WHAT WAS ALREADY TRIED (do not recommend something that just failed):\n` +
        m.recentActions
          .map((a) => `- ${a.at} ${a.toolName} → ${a.status}${a.subject ? ` on ${a.subject}` : ''}${a.error ? ` (${a.error})` : ''}`)
          .join('\n')
    )
  }
  if (m.knownPatterns.length > 0) {
    sections.push(
      `LESSONS FROM PAST INCIDENTS (experience, not rules — the policy engine still decides):\n` +
        m.knownPatterns
          .map(
            (p) =>
              `- "${p.patternKey}" (confidence ${p.confidence.toFixed(2)}, seen ${p.occurrences}x, ${p.falsePositives} false positive${p.falsePositives === 1 ? '' : 's'}): ${p.title}. ` +
              `Cause: ${p.probableCause}.` +
              (p.successfulResolution ? ` What worked: ${p.successfulResolution}.` : '') +
              (p.failedApproaches.length ? ` What did NOT work: ${p.failedApproaches.join('; ')}.` : '')
          )
          .join('\n')
    )
  }
  return sections.join('\n\n')
}

const compactTools = (input: AgentAnalysisInput): string =>
  input.availableTools
    .map((t) => `- ${t.name} [${t.classification}] — ${t.description}`)
    .join('\n')

/** Assemble the two messages. Pure — testable without a network. */
export function buildMessages(input: AgentAnalysisInput): Array<{ role: 'system' | 'user'; content: string }> {
  const user = [
    `AGENT MODE: ${input.mode}`,
    `STAGE 2 RECIPIENT LIMIT: ${input.stageRecipientLimit} (you may never recommend raising it)`,
    '',
    `POLICY:\n${input.policySummary.map((p) => `- ${p}`).join('\n')}`,
    '',
    `TOOLS YOU MAY NAME (classification is what the policy engine will do with it):\n${compactTools(input)}`,
    '',
    compactMemory(input),
    '',
    `FINDINGS THIS CYCLE (${input.findings.length}):\n\n${compactFindings(input)}`,
    '',
    OUTPUT_CONTRACT,
  ].join('\n')

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]
}

export { SYSTEM_PROMPT, OUTPUT_CONTRACT }
