import Anthropic from "@anthropic-ai/sdk";
import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";
import type {
  Assignee,
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";

// ---------------------------------------------------------------------------
// Anthropic client
// ---------------------------------------------------------------------------

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------------------------------------------------------------------------
// LLM-extracted triage assessment
// ---------------------------------------------------------------------------

interface LLMAssessment {
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: Discipline[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
  classification: Classification;
  urgency: Urgency;
  missing_info: string[];
  language: "en" | "es";
  safeguarding_signal: boolean;
  same_day_cancel: boolean;
  rationale: string;
}

async function extractWithLLM(item: InboxItem): Promise<LLMAssessment> {
  const systemPrompt = `You are an intake triage assistant for Cedar Kids Therapy, a pediatric therapy practice offering speech-language pathology (SLP), occupational therapy (OT), and physical therapy (PT).

Extract structured intake data and triage assessment from inbox messages. Respond with ONLY a valid JSON object — no markdown, no explanation, no preamble.

Urgency rules:
- P0: Any safeguarding concern, possible abuse, neglect, or unsafe caregiving. When in doubt, flag it.
- P1: Same-day cancellation or reschedule requiring immediate staff action.
- P2: Normal new referral, scheduling, billing, or admin workflow.
- P3: Low-priority question, FYI, no immediate action needed.

Classification options: new_referral, existing_patient_request, scheduling, clinical_question, billing_question, missing_paperwork, provider_followup, complaint, safeguarding, spam, other

Classification rules:
- If DOB, parent/guardian contact, AND insurance are all missing or blank, classify as missing_paperwork regardless of any other signals. Do not attempt to treat it as a new_referral.

Return this exact JSON shape:
{
  "child_name": string | null,
  "dob_or_age": string | null,
  "parent_contact": string | null,
  "discipline": ["SLP"|"OT"|"PT"] | null,
  "diagnosis_or_concern": string | null,
  "payer": string | null,
  "member_id": string | null,
  "classification": string,
  "urgency": "P0"|"P1"|"P2"|"P3",
  "missing_info": string[],
  "language": "en"|"es",
  "safeguarding_signal": boolean,
  "same_day_cancel": boolean,
  "rationale": string
}`;

  const userPrompt = `Channel: ${item.channel}
Sender: ${item.sender}
Subject: ${item.subject}
Body: ${item.body}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean) as LLMAssessment;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const results: ItemOutput[] = [];

  for (const item of inbox) {
    const output = await withItemContext(item.id, () => triageItem(item));
    results.push(output);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Per-item triage — LLM extracts, tools orchestrate
// ---------------------------------------------------------------------------

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  // Step 1: LLM extracts intake and initial assessment
  let assessment: LLMAssessment;
  try {
    assessment = await extractWithLLM(item);
  } catch (err) {
    console.error(`LLM extraction failed for ${item.id}:`, err);
    return await triageFallback(item);
  }

  // Step 2: Safety override — never rely solely on LLM for P0
  if (assessment.safeguarding_signal) {
    assessment.urgency = "P0";
    assessment.classification = "safeguarding";
  }

  const intake: ExtractedIntake = {
    child_name: assessment.child_name,
    dob_or_age: assessment.dob_or_age,
    parent_contact: assessment.parent_contact,
    discipline: assessment.discipline,
    diagnosis_or_concern: assessment.diagnosis_or_concern,
    payer: assessment.payer,
    member_id: assessment.member_id,
  };

  // Step 3: Route to appropriate handler based on assessment
  if (assessment.urgency === "P0" || assessment.safeguarding_signal) {
    return await handleSafeguarding(item, intake, assessment);
  }

  if (assessment.same_day_cancel || assessment.classification === "scheduling") {
    return await handleSameDayCancel(item, intake, assessment);
  }

  if (assessment.classification === "clinical_question") {
    return await handleClinicalQuestion(item, intake, assessment);
  }

  if (assessment.classification === "missing_paperwork") {
    return await handleMissingPaperwork(item, intake, assessment);
  }

  if (
    assessment.classification === "new_referral" ||
    assessment.classification === "existing_patient_request"
  ) {
    return await handleNewReferral(item, intake, assessment);
  }

  return await handleGeneric(item, intake, assessment);
}

// ---------------------------------------------------------------------------
// Handler: Safeguarding (P0)
// ---------------------------------------------------------------------------

async function handleSafeguarding(
  item: InboxItem,
  intake: ExtractedIntake,
  assessment: LLMAssessment,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "safeguarding" });

  const escResult = await escalate({
    item_id: item.id,
    reason: `Safeguarding signal detected in ${item.channel} from ${item.sender}. ${assessment.rationale}`,
    severity: "P0",
  });

  const taskResult = await create_task({
    assignee: "clinical_lead" as Assignee,
    title: `P0 Safeguarding review — ${item.subject}`,
    due: todayISO(),
    notes: `Clinical lead must review before any outbound contact. Item: ${item.id}. ${assessment.rationale}. Contact: ${intake.parent_contact ?? "unknown"}.`,
  });

  const channel = inferChannel(item);
  const draftBody =
    assessment.language === "es"
      ? `Hola, le llamamos de Cedar Kids Therapy para confirmar que recibimos su mensaje. Un miembro de nuestro equipo se comunicará con usted a la brevedad. Gracias.`
      : `Hi, this is Cedar Kids Therapy returning your message. We received your inquiry and a team member will be in touch shortly. Please feel free to call us back at your convenience.`;

  const draftResult = await draft_message({
    recipient: intake.parent_contact ?? item.sender,
    channel,
    language: assessment.language,
    body: draftBody,
  });

  return {
    item_id: item.id,
    classification: "safeguarding",
    urgency: "P0",
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Clinical lead must review immediately. Do not send draft reply or proceed with scheduling until clinical lead clears the safeguarding concern.",
    draft_reply: draftResult.args.body as string,
    task_ids: [taskResult.data.task_id],
    escalation: {
      reason: assessment.rationale,
      severity: "P0",
    },
    decision_rationale: `Safeguarding signal detected. ${assessment.rationale} P0 escalation created. Draft reply is a neutral callback acknowledgement only — no clinical or investigative content per policy.`,
  };
}

// ---------------------------------------------------------------------------
// Handler: Same-day cancellation (P1)
// ---------------------------------------------------------------------------

async function handleSameDayCancel(
  item: InboxItem,
  intake: ExtractedIntake,
  assessment: LLMAssessment,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "cancellation" });

  const taskIds: string[] = [];

  const patientResult =
    intake.child_name && intake.dob_or_age
      ? await search_patient({ name: intake.child_name, dob: intake.dob_or_age })
      : null;
  const patient = patientResult?.data[0] ?? null;

  const discipline = intake.discipline?.[0];
  const slotsResult = discipline ? await find_slots({ discipline }) : null;

  let holdId: string | null = null;
  if (slotsResult && slotsResult.data.length > 0) {
    const holdResult = await hold_slot({
      slot_id: slotsResult.data[0].slot_id,
      patient_ref: patient
        ? `${patient.patient_id} / ${intake.child_name}`
        : `${intake.child_name ?? "unknown"} / existing patient`,
    });
    holdId = holdResult.data.hold_id;
  }

  const taskResult = await create_task({
    assignee: "front_desk" as Assignee,
    title: `Same-day cancellation: ${intake.child_name ?? "patient"} — reschedule`,
    due: todayISO(),
    notes: `${intake.child_name ?? "Patient"} cancelled today's appointment. ${patient ? `Patient ID: ${patient.patient_id}.` : ""} ${holdId ? `Replacement slot held: ${holdId} — confirm with family before expiry.` : "No replacement slots found — staff to locate availability."} Contact: ${intake.parent_contact ?? "unknown"}.`,
  });
  taskIds.push(taskResult.data.task_id);

  const draftResult = await draft_message({
    recipient: intake.parent_contact ?? item.sender,
    channel: inferChannel(item),
    language: assessment.language,
    body: `Hi, we received your message and have cancelled today's appointment. A team member will be in touch shortly with rescheduling options. We hope ${intake.child_name ?? "your child"} feels better soon!`,
  });

  return {
    item_id: item.id,
    classification: "scheduling",
    urgency: "P1",
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: `Staff must cancel today's appointment in the schedule and confirm the rescheduled slot hold with the family today. Contact: ${intake.parent_contact ?? "unknown"}.`,
    draft_reply: draftResult.args.body as string,
    task_ids: taskIds,
    escalation: null,
    decision_rationale: `Same-day cancellation — scheduling policy classifies these as P1 operational issues. ${patient ? "Patient record confirmed in system." : "No patient record found."} ${holdId ? "Replacement slot held for staff review." : "No replacement slots available."}`,
  };
}

// ---------------------------------------------------------------------------
// Handler: Clinical question (P3)
// ---------------------------------------------------------------------------

async function handleClinicalQuestion(
  item: InboxItem,
  intake: ExtractedIntake,
  assessment: LLMAssessment,
): Promise<ItemOutput> {
  await lookup_policy({ topic: "clinical_advice" });

  const draftResult = await draft_message({
    recipient: intake.parent_contact ?? item.sender,
    channel: inferChannel(item),
    language: assessment.language,
    body:
      assessment.language === "es"
        ? `Hola, gracias por comunicarse con Cedar Kids Therapy. Las preguntas sobre el desarrollo de su hijo/a son muy importantes. Nuestro equipo clínico puede orientarle mejor en una evaluación. Si desea programar una consulta, con gusto le ayudamos.`
        : `Hi, thank you for reaching out to Cedar Kids Therapy. Questions about your child's development are always worth exploring, and our clinical team would be best placed to give you guidance specific to your child's situation. If you'd like, we can schedule a screening or evaluation — just let us know and we'll be happy to help.`,
  });

  return {
    item_id: item.id,
    classification: "clinical_question",
    urgency: "P3",
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Draft reply routes family to clinical evaluation — no clinical advice given. No further action required unless family responds to schedule.",
    draft_reply: draftResult.args.body as string,
    task_ids: [],
    escalation: null,
    decision_rationale: `Clinical question received. Policy prohibits clinical advice from front desk or automated systems. Draft reply warmly redirects to evaluation or screening. P3: no immediate operational action needed.`,
  };
}

// ---------------------------------------------------------------------------
// Handler: Missing paperwork
// ---------------------------------------------------------------------------

async function handleMissingPaperwork(
  item: InboxItem,
  intake: ExtractedIntake,
  assessment: LLMAssessment,
): Promise<ItemOutput> {
  const taskResult = await create_task({
    assignee: "front_desk" as Assignee,
    title: `Incomplete referral: ${intake.child_name ?? "unknown patient"} — contact referring provider`,
    due: tomorrowISO(),
    notes: `Referral received with missing fields: ${assessment.missing_info.join(", ")}. Contact referring provider (${item.sender}) to obtain missing information before any intake or scheduling step.`,
  });

  return {
    item_id: item.id,
    classification: "missing_paperwork",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: `Front desk should contact referring provider (${item.sender}) to obtain missing fields: ${assessment.missing_info.join(", ")}.`,
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale: `Referral is missing required fields: ${assessment.missing_info.join(", ")}. No insurance verification or slot search can proceed without this information.`,
  };
}

// ---------------------------------------------------------------------------
// Handler: New referral (core workflow)
// ---------------------------------------------------------------------------

async function handleNewReferral(
  item: InboxItem,
  intake: ExtractedIntake,
  assessment: LLMAssessment,
): Promise<ItemOutput> {
  const taskIds: string[] = [];

  // Search for existing patient record
  const patientResult =
    intake.child_name && intake.dob_or_age
      ? await search_patient({ name: intake.child_name, dob: intake.dob_or_age })
      : null;
  const patient = patientResult?.data[0] ?? null;

  // Verify insurance if payer present
  const insResult = intake.payer
    ? await verify_insurance({
        payer: intake.payer,
        member_id: intake.member_id ?? undefined,
      })
    : null;

  const insStatus = insResult?.data.status ?? "unknown";
  const insData = insResult?.data;

  if (insStatus === "out_of_network") {
    await lookup_policy({ topic: "insurance" });

    const taskResult = await create_task({
      assignee: "billing" as Assignee,
      title: `Out-of-network benefits discussion: ${intake.child_name ?? "patient"} (${intake.payer})`,
      due: tomorrowISO(),
      notes: `${intake.payer} verified out of network. Contact ${intake.parent_contact ?? "family"} to explain options before any slot hold or scheduling.`,
    });
    taskIds.push(taskResult.data.task_id);

    const draftResult = await draft_message({
      recipient: intake.parent_contact ?? item.sender,
      channel: inferChannel(item),
      language: assessment.language,
      body:
        assessment.language === "es"
          ? `Hola, gracias por enviar la referencia. Necesitamos informarle que ${intake.payer} actualmente está fuera de nuestra red. Nuestro equipo de facturación le contactará pronto para revisar sus opciones.`
          : `Hi, thank you for sending ${intake.child_name ?? "the"} referral. We want to let you know that ${intake.payer} is currently out of network for Cedar Kids Therapy. Our billing team will reach out shortly to walk through your options before we move forward with scheduling.`,
    });

    return {
      item_id: item.id,
      classification: assessment.classification,
      urgency: "P2",
      requires_human_review: true,
      extracted_intake: intake,
      missing_info: assessment.missing_info,
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: `Billing must have an out-of-network benefits conversation with family before any slot is held for ${intake.child_name ?? "patient"}.`,
      draft_reply: draftResult.args.body as string,
      task_ids: taskIds,
      escalation: null,
      decision_rationale: `Referral received. Insurance verification returned out_of_network for ${intake.payer}. Policy requires benefits conversation before any scheduling step. No slot hold initiated.`,
    };
  }

  if (insStatus === "expired") {
    await lookup_policy({ topic: "insurance" });

    const taskResult = await create_task({
      assignee: "billing" as Assignee,
      title: `Expired insurance: ${intake.child_name ?? "patient"} — verify coverage`,
      due: tomorrowISO(),
      notes: `${intake.payer} shows as expired. Contact ${intake.parent_contact ?? "family"} to obtain current insurance before proceeding.`,
    });
    taskIds.push(taskResult.data.task_id);

    const draftResult = await draft_message({
      recipient: intake.parent_contact ?? item.sender,
      channel: inferChannel(item),
      language: assessment.language,
      body:
      assessment.language === "es"
        ? `Hola, gracias por enviar la referencia de ${intake.child_name ?? "su hijo/a"}. Necesitamos actualizar la información de seguro. Nuestro equipo de facturación le contactará pronto para confirmar la cobertura antes de continuar.`
        : `Hi, thank you for sending ${intake.child_name ?? "the"} referral. We noticed the insurance information may need to be updated. Our billing team will reach out shortly to confirm coverage before we move forward.`,
    });

    return {
      item_id: item.id,
      classification: assessment.classification,
      urgency: "P2",
      requires_human_review: true,
      extracted_intake: intake,
      missing_info: assessment.missing_info,
      tools_called: getToolCallsForItem(item.id),
      recommended_next_action: `Billing should contact family to verify current insurance for ${intake.child_name ?? "patient"} — system shows coverage as expired.`,
      draft_reply: draftResult.args.body as string,
      task_ids: taskIds,
      escalation: null,
      decision_rationale: `Insurance verification returned expired for ${intake.payer}. Billing task created; no slot held until coverage confirmed.`,
    };
  }

  // In-network or unknown — proceed with slot search
  const discipline = intake.discipline?.[0];
  const slotsResult = discipline
    ? await find_slots({
        discipline,
        language: assessment.language === "es" ? "es" : undefined,
      })
    : null;

  let holdId: string | null = null;
  if (slotsResult && slotsResult.data.length > 0) {
    const holdResult = await hold_slot({
      slot_id: slotsResult.data[0].slot_id,
      patient_ref: patient
        ? `${patient.patient_id} / ${intake.child_name}`
        : `${intake.child_name ?? "new patient"} / new patient`,
    });
    holdId = holdResult.data.hold_id;
  }

  const taskResult = await create_task({
    assignee: "front_desk" as Assignee,
    title: `${patient ? "Existing" : "New"} patient intake: ${intake.child_name ?? "patient"} (${discipline ?? "discipline TBD"})`,
    due: tomorrowISO(),
    notes: `Insurance: ${insStatus}${insData?.copay !== undefined ? `, copay $${insData.copay}` : ""}${insData?.auth_required ? ", auth required before first visit" : ""}. ${patient ? `Existing patient ID: ${patient.patient_id}.` : "No existing record — create new patient file."} ${holdId ? `Slot hold: ${holdId} — confirm before expiry.` : "No slots found — staff to locate availability."} Contact: ${intake.parent_contact ?? "unknown"}.${assessment.language === "es" ? " Spanish-speaking family." : ""}`,
  });
  taskIds.push(taskResult.data.task_id);

  const draftResult = await draft_message({
    recipient: intake.parent_contact ?? item.sender,
    channel: inferChannel(item),
    language: assessment.language,
    body:
      assessment.language === "es"
        ? `Hola, gracias por enviar la referencia de ${intake.child_name ?? "su hijo/a"}. Hemos recibido su información y estamos preparando el proceso de ingreso. Alguien le contactará pronto para confirmar la cita de evaluación.`
        : `Hi, thank you for sending ${intake.child_name ?? "the"} referral. We have received the information and are preparing the intake. A team member will be in touch shortly to confirm the evaluation appointment.`,
  });

  return {
    item_id: item.id,
    classification: assessment.classification,
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: `Staff should confirm the pending slot hold for ${intake.child_name ?? "patient"} and send the drafted reply.${insData?.auth_required ? " Auth required before first visit." : ""}`,
    draft_reply: draftResult.args.body as string,
    task_ids: taskIds,
    escalation: null,
    decision_rationale: `${assessment.rationale} Insurance: ${insStatus}. ${patient ? "Existing patient record found." : "No existing record."} ${holdId ? "Slot hold created for staff review." : "No slots available."} ${insData?.auth_required ? "Auth required." : ""}`,
  };
}

// ---------------------------------------------------------------------------
// Handler: Generic
// ---------------------------------------------------------------------------

async function handleGeneric(
  item: InboxItem,
  intake: ExtractedIntake,
  assessment: LLMAssessment,
): Promise<ItemOutput> {
  const taskResult = await create_task({
    assignee: "front_desk" as Assignee,
    title: `Manual review: ${item.subject ?? item.id}`,
    due: tomorrowISO(),
    notes: `Item ${item.id} classified as ${assessment.classification}. ${assessment.rationale} Channel: ${item.channel}. Contact: ${intake.parent_contact ?? "unknown"}.`,
  });

  return {
    item_id: item.id,
    classification: assessment.classification,
    urgency: assessment.urgency,
    requires_human_review: true,
    extracted_intake: intake,
    missing_info: assessment.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: "Staff to review item and determine next steps.",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale: assessment.rationale,
  };
}

// ---------------------------------------------------------------------------
// Fallback: LLM failure
// ---------------------------------------------------------------------------

async function triageFallback(item: InboxItem): Promise<ItemOutput> {
  const taskResult = await create_task({
    assignee: "front_desk" as Assignee,
    title: `Manual review required (extraction failed): ${item.subject ?? item.id}`,
    due: tomorrowISO(),
    notes: `Automated triage could not process item ${item.id}. Please review manually. Channel: ${item.channel}. Sender: ${item.sender}.`,
  });

  return {
    item_id: item.id,
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["All fields — extraction failed, manual review required"],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: "Staff must review this item manually.",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale: "LLM extraction failed. Routed to manual review as a safe fallback.",
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function inferChannel(item: InboxItem): "portal" | "email" | "phone" {
  if (item.channel === "portal_message") return "portal";
  if (item.channel === "email") return "email";
  return "phone";
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
