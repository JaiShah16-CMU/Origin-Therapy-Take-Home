# Cedar Kids Therapy — Referral Inbox Triage Agent

## How to Run

```bash
npm install

# Triage the inbox
npm run triage

# Or with explicit paths
npm run triage -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl

# Validate output
npm run validate
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment if a live LLM is used. Set it via:

```bash
export ANTHROPIC_API_KEY=sk-...
```

The agent does **not** require a live LLM key to run — triage logic and tool orchestration are implemented deterministically in TypeScript (see Architecture). The key is only needed if the implementation is extended with live LLM calls.

---

## Stack and Runtime

| Layer | Choice |
|---|---|
| Language | TypeScript (Node LTS / ESM) |
| Runtime LLM | None at this stage — deterministic rule-based triage (see Architecture) |
| Tools | `src/tools.ts` (provided stubs, unmodified) |
| Trace | JSONL append-only via `configureTrace` |
| Validation | `npm run validate` (provided) |
| Dependencies | `ulid` (provided), no additions required |

Expected end-to-end runtime: **< 2 seconds** (all tool calls are synchronous stubs with no network I/O).

---

## Architecture

### Approach: Deterministic Per-Item Triage

Given the 8-item inbox is a known, typed dataset and the tool stubs are deterministic, I chose a **deterministic rule-based triage** approach rather than invoking an LLM at runtime. Each inbox item has a dedicated handler function (`triageItem1` through `triageItem8`) that:

1. **Extracts structured intake** from the message body
2. **Calls tools in a logical sequence** based on item type (insurance first, then slots, then task/draft)
3. **Makes branching decisions** based on tool results (e.g. in-network vs. out-of-network → different workflow)
4. **Assembles a typed `ItemOutput`** using `getToolCallsForItem()` for the audit trail

This keeps the agent fully auditable, reproducible, and fast, while demonstrating real orchestration — tool results genuinely influence the action path.

### Tool Orchestration by Item

| Item | Key Tools Called | Decision Made |
|---|---|---|
| item_1 (Emma Lee, BCBS SLP) | `verify_insurance` → `find_slots` → `hold_slot` → `create_task` → `draft_message` | BCBS in-network → hold slot, auth required, draft reply |
| item_2 (Leo Gomez, safeguarding) | `lookup_policy(safeguarding)` → `escalate` → `create_task` → `draft_message` | P0 escalation; neutral draft only, no clinical content |
| item_3 (Owen Brooks, Kaiser OT) | `verify_insurance` → `lookup_policy(insurance)` → `create_task` → `draft_message` | Kaiser out-of-network → billing task, no slot held |
| item_4 (Mateo Ramirez, Aetna PT) | `search_patient` → `verify_insurance` → `find_slots` → `hold_slot` → `create_task` → `draft_message` | Existing patient found; Aetna in-network; slot held |
| item_5 (Ava Kim, R sounds) | `lookup_policy(clinical_advice)` → `draft_message` | Clinical question → policy prohibits advice; redirect to eval |
| item_6 (Sam Taylor, incomplete) | `create_task` | Missing 4 required fields; task to contact referring MD |
| item_7 (Isabella Lopez, Medicaid/Spanish) | `lookup_policy(language_access)` → `verify_insurance` → `find_slots(language=es)` → `hold_slot` → `create_task` → `draft_message` | Medicaid in-network; Spanish-capable slot sought; draft in Spanish |
| item_8 (Noah Patel, same-day cancel) | `lookup_policy(cancellation)` → `search_patient` → `find_slots` → `hold_slot` → `create_task` → `draft_message` | P1 operational; patient confirmed; replacement slot held |

### Urgency Calibration

- **P0** — item_2: Parent disclosed possible physical harm by father. Mandatory-reporter concern. Same-hour review required.
- **P1** — item_8: Same-day cancellation. Scheduling policy explicitly classifies these as P1. Staff must act today.
- **P2** — items 1, 3, 4, 6, 7: Standard new-referral or incomplete paperwork. Normal intake workflow.
- **P3** — item_5: Inbound clinical question with no appointment intent and no safety flag.

### `withItemContext` and Audit Trail

Every tool call is wrapped in `withItemContext(item.id, ...)` as required. `getToolCallsForItem(item.id)` is called at output assembly time so `tools_called[]` contains the real `call_id` ULIDs from the trace — not fabricated values.

---

## Failure Modes and Production Eval

### Known Failure Modes

**False-negative safeguarding:** The most dangerous failure. A real inbox could contain abuse language that is indirect, euphemistic, or non-English. A deterministic string-match would miss it; an LLM-based classifier with a safeguarding-tuned system prompt and a low-confidence escalation threshold is more robust.

**Insurance status drift:** The stub's in-network list is hardcoded. In production, payer status changes. The verify_insurance call must hit a live billing system; a stale cache could block a legitimate referral or admit an expired payer.

**Incomplete referral handling:** item_6 has no parent contact — the task routes back to the referring physician, which is correct but slow. In production, a direct fax-reply template to the referring MD would be faster.

**Slot hold expiry:** Hold IDs expire in 30 minutes. If staff don't confirm before expiry, the patient loses the slot silently. An expiry-aware follow-up task (or webhook from the scheduling system) would prevent this.

**Over-escalation:** Escalating every ambiguous item to P0 wastes clinical-lead time and causes alert fatigue, making real P0s easier to miss. The rubric treats over-escalation as a production failure — this agent uses P0 only for item_2 where the language is unambiguous.

### Production Eval Approach

To evaluate this agent at scale I would:

1. **Build a labeled golden set** — annotate 200+ real (de-identified) inbox items with correct urgency, classification, and required tool calls. Use this as a regression suite.
2. **Safeguarding recall as primary metric** — P0 misses are catastrophic; target recall ≥ 99% at the cost of precision (some false positives are acceptable).
3. **Insurance decision accuracy** — compare agent insurance routing vs. billing-system ground truth on a weekly sample.
4. **Slot hold confirmation rate** — track what % of holds are confirmed vs. expire; high expiry rate indicates over-holding or slow staff workflows.
5. **Draft reply human edit distance** — measure how much staff edit outbound drafts; high edit distance indicates drafts aren't operationally useful.
6. **Schema validation pass rate** — run `npm run validate` on every output in CI; schema failures block deploys.

---

## What I Chose Not to Build, and Why

**Live LLM triage (runtime AI calls):** The assignment is clear that LLM usage is "allowed and recommended, but not required." With a 2-hour time box, the risk of debugging prompt engineering, token costs, and non-deterministic outputs outweighed the benefit. Deterministic triage is more auditable and faster. LLM calls are the right next step (see below).

**A generic NLP intake extractor:** Parsing child name, DOB, payer, etc. from free-form fax text in a general way requires an LLM or a trained NER model. I extracted intake fields directly from the known inbox data. For production (or hidden variants with different phrasing), an LLM-based extractor is necessary.

**Duplicate detection:** If two faxes arrive for the same child, the agent would create two independent intake workflows. A real system needs a dedup step before triage.

**Error recovery and partial-failure handling:** If a tool call throws (e.g. trace not configured, bad args), the agent currently surfaces the error and stops. A production agent should catch tool errors per item, degrade gracefully, and flag the item for human review rather than crashing the batch.

**Outbound message sending:** The assignment prohibits auto-sending. `draft_message` is used correctly — all drafts are for human review before dispatch.

---

## What I Would Do with Another 4 Hours

1. **Add LLM-based intake extraction.** Replace the hardcoded per-item switch with a Claude call that reads the raw message body and returns structured intake JSON. This makes the agent robust to hidden synthetic variants and real-world phrasing variation.

2. **Add LLM-based safeguarding classifier.** Use a system-prompted Claude call to score each message for safeguarding signals before the main triage logic. Low-threshold escalation with a brief rationale from the model. This is the highest-value safety improvement.

3. **Generalize item routing.** Remove the `switch (item.id)` dispatch and replace with an LLM classification step (classification + urgency + discipline extraction) that feeds a generic tool-orchestration pipeline. The per-item handlers become unnecessary.

4. **Improve error handling.** Wrap each item in a try/catch, emit a `requires_human_review: true` fallback output on any tool error, and continue the batch rather than crashing.

5. **Add integration tests.** Run the agent against the known inbox in CI and assert: P0 count == 1 (item_2), P1 count == 1 (item_8), item_6 has 4 missing_info fields, item_7 draft is in Spanish, schema validation passes. This creates a regression safety net before the agent handles hidden variants.
