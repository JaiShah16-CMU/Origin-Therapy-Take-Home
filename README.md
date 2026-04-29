# Cedar Kids Therapy — Referral Inbox Triage Agent

## How to Run

```bash
npm install

# Set your Anthropic API key
export ANTHROPIC_API_KEY=your-key-here

# Triage the inbox
npm run triage

# Or with explicit paths
npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl

# Validate output
npm run validate
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Expected end-to-end runtime: **15–30 seconds** (8 sequential LLM calls + synchronous tool stubs).

If no API key is set, the agent degrades gracefully — each item falls back to a `create_task` for manual review and the batch still completes without crashing.

---

## Stack and Runtime

| Layer | Choice |
|---|---|
| Language | TypeScript (Node LTS / ESM) |
| Runtime LLM | Anthropic Claude (`claude-sonnet-4-6`) via `@anthropic-ai/sdk` |
| LLM role | Intake extraction + triage assessment per inbox item |
| Tools | `src/tools.ts` (provided stubs, unmodified) |
| Trace | JSONL append-only via `configureTrace` |
| Validation | `npm run validate` (provided) |
| Key dependencies | `@anthropic-ai/sdk`, `ulid`, `tsx` |

---

## Architecture

### Overview

Each inbox item goes through a two-stage pipeline:

```
Raw message body
      │
      ▼
┌─────────────────────────┐
│  Claude (LLM extraction) │  ← extracts intake fields + triage assessment
└─────────────────────────┘
      │
      ▼ structured JSON assessment
┌─────────────────────────┐
│  Tool orchestration      │  ← deterministic routing + tool calls
└─────────────────────────┘
      │
      ▼
  ItemOutput
```

**Stage 1 — LLM extraction (`extractWithLLM`)**

Claude reads the raw message and returns a structured JSON object containing:
- Intake fields: child name, DOB, parent contact, discipline, diagnosis, payer, member ID
- Triage assessment: classification, urgency, missing fields, language (en/es)
- Safety flags: `safeguarding_signal`, `same_day_cancel`
- Rationale: plain-English explanation of the assessment

This means the agent generalizes to any inbox message — it is not hardcoded to specific item IDs or known phrasing. Tested against novel synthetic inputs including out-of-network insurance, Spanish-language voicemails, incomplete referrals, and safeguarding disclosures.

**Stage 2 — Tool orchestration**

The LLM output feeds a deterministic routing layer that decides which tools to call and in what order:

| Route | Trigger | Key tools |
|---|---|---|
| Safeguarding | `safeguarding_signal: true` or `urgency: P0` | `lookup_policy` → `escalate` → `create_task` → `draft_message` |
| Same-day cancel | `same_day_cancel: true` or `classification: scheduling` | `lookup_policy` → `search_patient` → `find_slots` → `hold_slot` → `create_task` → `draft_message` |
| Clinical question | `classification: clinical_question` | `lookup_policy` → `draft_message` |
| Missing paperwork | `classification: missing_paperwork` | `create_task` |
| New referral | `classification: new_referral` | `search_patient` → `verify_insurance` → (branch) → `find_slots` → `hold_slot` → `create_task` → `draft_message` |

**Insurance branching within new referral:**
- `out_of_network` → billing task created, no slot held, draft explains OON situation
- `expired` → billing task created, no slot held, draft asks family to update coverage
- `in_network` or `unknown` → find slots, hold slot, intake task for front desk

**Safety override — never trust LLM alone on P0:**

```typescript
if (assessment.safeguarding_signal) {
  assessment.urgency = "P0";
  assessment.classification = "safeguarding";
}
```

Even if the LLM underestimates urgency, the hard override forces P0 whenever a safeguarding signal is present. The neutral draft reply contains no clinical or investigative content per policy. Tested against both explicit and indirect safeguarding language — correctly escalated in all cases.

**Missing paperwork rule in system prompt:**

The LLM prompt explicitly instructs: if DOB, parent contact, and insurance are all blank, classify as `missing_paperwork` — not `new_referral`. This prevents the agent from attempting to hold slots for incomplete referrals.

**Graceful degradation:**

If the LLM call fails for any item (network error, API outage, malformed response), the item falls back to a `create_task` for manual review rather than crashing the batch. All other items continue processing normally.

---

## Failure Modes and Production Eval

### Known failure modes

**False-negative safeguarding:** The highest-stakes failure. Indirect, euphemistic, or non-English abuse language could be missed. Mitigations: low-confidence threshold in the LLM prompt, hard code override, and a dedicated safeguarding classifier as a second pass.

**LLM hallucination on intake fields:** Claude might infer a field that isn't present (e.g. guessing a payer from context). In production, extracted fields should be confidence-scored and low-confidence extractions flagged as missing rather than assumed.

**Insurance status drift:** `verify_insurance` stubs are deterministic. In production, payer status changes — a stale cache could block a legitimate referral or pass an expired one. The live billing system is the source of truth.

**Slot hold expiry:** Holds expire in 30 minutes. If staff don't confirm, the patient loses the slot silently. An expiry-aware follow-up task or webhook would prevent this.

**Over-escalation:** Treating every ambiguous item as P0 wastes clinical-lead time and causes alert fatigue, making real P0s easier to miss. The LLM prompt instructs conservative P0 use; the hard override only fires on explicit `safeguarding_signal`.

**Sequential LLM calls:** The agent processes items one at a time. For a large batch this is slow. In production, items should be processed in parallel with a concurrency limit.

### Production eval approach

1. **Labeled golden set** — annotate 200+ de-identified inbox items with correct urgency, classification, and required tool calls. Run as a regression suite on every deploy.
2. **Safeguarding recall as primary metric** — P0 misses are catastrophic. Target recall ≥ 99% at the cost of precision.
3. **Insurance decision accuracy** — compare agent routing vs. billing-system ground truth on a weekly sample.
4. **Slot hold confirmation rate** — high expiry rate signals over-holding or slow staff workflows.
5. **Draft reply edit distance** — measure how much staff edit outbound drafts. High edit distance means drafts aren't operationally useful.
6. **Schema validation in CI** — `npm run validate` runs on every output in CI; schema failures block deploys.

---

## What I Chose Not to Build, and Why

**Parallel LLM calls:** Processing items sequentially keeps the code simple and the trace deterministic. For 8 items the runtime is acceptable (~20s). In production, `Promise.all` with a concurrency limiter would be the right approach.

**Confidence scoring on extracted fields:** The LLM sometimes infers fields from context rather than explicit text. A production system would score confidence and treat low-confidence extractions as missing. Cut for time — the `missing_info` array handles the most obvious gaps.

**Duplicate detection:** If two faxes arrive for the same child, the agent creates two independent intake workflows. A dedup step before triage would be needed in production.

**Outbound message sending:** The assignment prohibits auto-sending. `draft_message` is used correctly — all drafts are for human review before dispatch.

**A second-pass safeguarding classifier:** A dedicated system-prompted classifier with a very low threshold would add a second layer of safety beyond the primary LLM extraction. Cut for time — the hard override in code provides a meaningful second layer already.

---

## What I Would Do with Another 4 Hours

1. **Parallel processing with concurrency limit.** Process all 8 items concurrently with `Promise.all` and a semaphore (e.g. max 3 simultaneous LLM calls). This would cut runtime from ~20s to ~8s and is the right production pattern.

2. **Confidence scoring on intake extraction.** Ask the LLM to return a confidence score per field. Fields below a threshold get added to `missing_info` rather than used as inputs to tool calls. This prevents hallucinated payer names or DOBs from flowing into downstream decisions.

3. **Dedicated safeguarding pre-pass.** Run a fast, system-prompted binary classifier on every item before the main extraction step. Any item scoring above a low threshold gets immediately routed to the safeguarding handler regardless of what the main extraction returns. Two independent classifiers make catastrophic misses much less likely.

4. **Integration test suite.** A set of labeled synthetic items covering: clean in-network referral, OON referral, expired insurance, incomplete referral, same-day cancel, clinical question, Spanish-speaking family, and safeguarding (obvious and indirect). Run with `npm test` in CI and assert urgency, classification, and key tool calls match expected values.

5. **Structured logging and observability.** Replace `console.error` with structured JSON logs per item including LLM latency, token usage, and tool call outcomes. Makes it easy to spot slow items, expensive prompts, or systematic extraction errors in production.
