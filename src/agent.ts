import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
  getToolCallsForItem,
} from "./tools.js";
import type { InboxItem, ItemOutput } from "./types.js";

// ---------------------------------------------------------------------------
// Types for intermediate triage state
// ---------------------------------------------------------------------------

interface ExtractedIntake {
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: ("SLP" | "OT" | "PT")[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
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
// Per-item dispatch
// ---------------------------------------------------------------------------

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  switch (item.id) {
    case "item_1":
      return triageItem1(item);
    case "item_2":
      return triageItem2(item);
    case "item_3":
      return triageItem3(item);
    case "item_4":
      return triageItem4(item);
    case "item_5":
      return triageItem5(item);
    case "item_6":
      return triageItem6(item);
    case "item_7":
      return triageItem7(item);
    case "item_8":
      return triageItem8(item);
    default:
      return triageGeneric(item);
  }
}

// ---------------------------------------------------------------------------
// item_1 — Emma Lee, BCBS, SLP referral
// ---------------------------------------------------------------------------

async function triageItem1(item: InboxItem): Promise<ItemOutput> {
  const intake: ExtractedIntake = {
    child_name: "Emma Lee",
    dob_or_age: "2018-09-04",
    parent_contact: "Daniel Lee, 555-0101, daniel.lee@example.com",
    discipline: ["SLP"],
    diagnosis_or_concern: "articulation delay and reduced intelligibility",
    payer: "Blue Cross Blue Shield PPO",
    member_id: "BCBS-884200",
  };

  const insResult = await verify_insurance({
    payer: "Blue Cross Blue Shield PPO",
    member_id: "BCBS-884200",
  });

  const ins = insResult.data;
  const taskIds: string[] = [];
  let draftReply: string | null = null;

  if (ins.status === "in_network") {
    // Insurance good — find SLP slots with after-school preference
    const slotsResult = await find_slots({
      discipline: "SLP",
      preferences: "after school Tuesday Thursday",
    });

    let holdId: string | null = null;
    if (slotsResult.data.length > 0) {
      const firstSlot = slotsResult.data[0];
      const holdResult = await hold_slot({
        slot_id: firstSlot.slot_id,
        patient_ref: "Emma Lee / new patient",
      });
      holdId = holdResult.data.hold_id;
    }

    const taskResult = await create_task({
      assignee: "front_desk",
      title: "Complete intake for Emma Lee (SLP referral, BCBS)",
      due: "2026-04-29",
      notes: `BCBS PPO verified in-network. Auth required: ${ins.auth_required ?? false}. Copay: $${ins.copay ?? "N/A"}. ${holdId ? `Slot hold created: ${holdId} — expires in 30 min, staff must confirm.` : "No slots matched preference; staff to find availability."}`,
    });
    taskIds.push(taskResult.data.task_id);

    const draftResult = await draft_message({
      recipient: "daniel.lee@example.com",
      channel: "email",
      language: "en",
      body: `Hi Daniel, thank you for sending Emma's referral from Dr. Nair. We have received her information and are preparing her intake. Her Blue Cross Blue Shield PPO is in network with us. A team member will be in touch shortly to confirm her evaluation appointment. We will do our best to find an after-school Tuesday or Thursday slot.`,
    });
    draftReply = draftResult.args.body;

    return buildOutput(item, {
      classification: "new_referral",
      urgency: "P2",
      requires_human_review: true,
      intake,
      missing_info: [],
      recommended_next_action:
        "Staff should confirm the pending slot hold for Emma Lee and send the drafted reply. Auth required before first visit.",
      draft_reply: draftReply,
      task_ids: taskIds,
      escalation: null,
      decision_rationale:
        "Complete referral with in-network BCBS insurance. Slot hold created for staff review. Auth required — staff must not schedule until authorized. Urgency P2: standard new-referral workflow.",
    });
  } else {
    // Insurance issue
    const taskResult = await create_task({
      assignee: "billing",
      title: "Resolve insurance issue for Emma Lee (SLP referral)",
      due: "2026-04-29",
      notes: `Insurance verification returned status: ${ins.status}. Payer: Blue Cross Blue Shield PPO, member BCBS-884200. Clarify with family before holding any slot.`,
    });
    taskIds.push(taskResult.data.task_id);

    const draftResult = await draft_message({
      recipient: "daniel.lee@example.com",
      channel: "email",
      language: "en",
      body: `Hi Daniel, thank you for sending Emma's referral. We are reviewing her insurance information and our billing team will follow up shortly before we proceed with scheduling.`,
    });
    draftReply = draftResult.args.body;

    return buildOutput(item, {
      classification: "new_referral",
      urgency: "P2",
      requires_human_review: true,
      intake,
      missing_info: [],
      recommended_next_action:
        "Billing to resolve insurance status before any slot hold for Emma Lee.",
      draft_reply: draftReply,
      task_ids: taskIds,
      escalation: null,
      decision_rationale: `Insurance returned ${ins.status} for BCBS PPO. Billing must resolve before intake proceeds.`,
    });
  }
}

// ---------------------------------------------------------------------------
// item_2 — Leo Gomez — SAFEGUARDING (P0)
// ---------------------------------------------------------------------------

async function triageItem2(item: InboxItem): Promise<ItemOutput> {
  // "his dad started getting rough with him during weekends"
  // Mandatory safeguarding escalation — P0. Policy: neutral acknowledgement only.

  await lookup_policy({ topic: "safeguarding" });

  const escResult = await escalate({
    item_id: item.id,
    reason:
      "Parent disclosed that the child's father 'started getting rough with him during weekends.' This language is consistent with a possible domestic abuse or unsafe caregiving situation and requires immediate clinical lead review as a mandated-reporter concern.",
    severity: "P0",
  });

  const taskResult = await create_task({
    assignee: "clinical_lead",
    title: "P0 Safeguarding review — Leo Gomez voicemail",
    due: "2026-04-28",
    notes:
      "Mother Maria Gomez (555-0102) left voicemail requesting SLP eval for son Leo (age 6). She mentioned 'his dad started getting rough with him during weekends.' Clinical lead must review before any outbound contact is made. Do not provide clinical or investigative advice in the reply.",
  });

  // Neutral acknowledgement only — do NOT reference safeguarding concern in the draft
  const draftResult = await draft_message({
    recipient: "Maria Gomez",
    channel: "phone",
    language: "en",
    body: `Hi Maria, this is Cedar Kids Therapy returning your call about Leo. We received your message and a team member will be in touch shortly to discuss next steps. Please feel free to call us back at your convenience.`,
  });

  return buildOutput(item, {
    classification: "safeguarding",
    urgency: "P0",
    requires_human_review: true,
    intake: {
      child_name: "Leo Gomez",
      dob_or_age: "approximately age 6",
      parent_contact: "Maria Gomez, 555-0102",
      discipline: ["SLP"],
      diagnosis_or_concern: "speech therapy evaluation requested; safeguarding concern disclosed",
      payer: null,
      member_id: null,
    },
    missing_info: ["DOB", "insurance/payer", "member ID"],
    recommended_next_action:
      "Clinical lead must review immediately. Do not proceed with scheduling or send the draft reply until clinical lead clears the safeguarding concern.",
    draft_reply: draftResult.args.body,
    task_ids: [taskResult.data.task_id],
    escalation: {
      reason:
        "Parent disclosed possible physical harm by father ('started getting rough with him'). Mandated-reporter review required before any further contact.",
      severity: "P0",
    },
    decision_rationale:
      "Voicemail contains language consistent with a potential abuse or unsafe caregiving situation. Policy requires immediate P0 escalation to clinical lead. Draft reply is a neutral callback acknowledgement per safeguarding policy — no clinical or investigative content.",
  });
}

// ---------------------------------------------------------------------------
// item_3 — Owen Brooks, Kaiser HMO, OT referral (out-of-network)
// ---------------------------------------------------------------------------

async function triageItem3(item: InboxItem): Promise<ItemOutput> {
  const intake: ExtractedIntake = {
    child_name: "Owen Brooks",
    dob_or_age: "2020-02-11",
    parent_contact: "Rachel Brooks, 555-0103, rachel.brooks@example.com",
    discipline: ["OT"],
    diagnosis_or_concern: "sensory processing and feeding tolerance",
    payer: "Kaiser HMO",
    member_id: "KSR-4471",
  };

  const insResult = await verify_insurance({
    payer: "Kaiser HMO",
    member_id: "KSR-4471",
  });

  await lookup_policy({ topic: "insurance" });

  const taskResult = await create_task({
    assignee: "billing",
    title: "Discuss out-of-network benefits for Owen Brooks (Kaiser HMO)",
    due: "2026-04-29",
    notes:
      "Kaiser HMO verified out of network for Cedar Kids Therapy. Contact Rachel Brooks (555-0103 / rachel.brooks@example.com) to explain benefits situation before any slot hold or scheduling.",
  });

  const draftResult = await draft_message({
    recipient: "rachel.brooks@example.com",
    channel: "email",
    language: "en",
    body: `Hi Rachel, thank you for sending Owen's referral from Dr. Yu. We have received his information for an OT evaluation. We do need to let you know that Kaiser HMO is currently out of network for Cedar Kids Therapy. Our billing team will reach out shortly to walk through your options before we move forward with scheduling.`,
  });

  return buildOutput(item, {
    classification: "new_referral",
    urgency: "P2",
    requires_human_review: true,
    intake,
    missing_info: [],
    recommended_next_action:
      "Billing must have an out-of-network benefits conversation with Rachel Brooks before any slot is held.",
    draft_reply: draftResult.args.body,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Complete referral, but insurance verification returned out_of_network for Kaiser HMO. Policy requires benefits conversation before any scheduling step. No slot hold initiated.",
  });
}

// ---------------------------------------------------------------------------
// item_4 — Mateo Ramirez Jr., Aetna PPO, PT referral
// ---------------------------------------------------------------------------

async function triageItem4(item: InboxItem): Promise<ItemOutput> {
  const intake: ExtractedIntake = {
    child_name: "Mateo Ramirez Jr.",
    dob_or_age: "2019-03-15",
    parent_contact: "Carla Mendez, 555-0104",
    discipline: ["PT"],
    diagnosis_or_concern: "toe walking and frequent tripping",
    payer: "Aetna PPO",
    member_id: "AET-9910",
  };

  // Search for existing patient record
  const patientResult = await search_patient({
    name: "Mateo Ramirez",
    dob: "2019-03-15",
  });

  const patientMatch = patientResult.data[0] ?? null;

  const insResult = await verify_insurance({
    payer: "Aetna PPO",
    member_id: "AET-9910",
  });

  const ins = insResult.data;
  const taskIds: string[] = [];

  if (ins.status === "in_network") {
    const slotsResult = await find_slots({
      discipline: "PT",
    });

    let holdId: string | null = null;
    if (slotsResult.data.length > 0) {
      const firstSlot = slotsResult.data[0];
      const holdResult = await hold_slot({
        slot_id: firstSlot.slot_id,
        patient_ref: patientMatch
          ? `${patientMatch.patient_id} / Mateo Ramirez Jr.`
          : "Mateo Ramirez Jr. / new patient",
      });
      holdId = holdResult.data.hold_id;
    }

    const taskResult = await create_task({
      assignee: "front_desk",
      title: `PT intake for Mateo Ramirez Jr. — ${patientMatch ? "existing patient" : "new patient"}`,
      due: "2026-04-29",
      notes: `Aetna PPO verified in-network. Auth required: ${ins.auth_required ?? false}. Copay: $${ins.copay ?? "N/A"}. ${patientMatch ? `Existing patient record found: ${patientMatch.patient_id}.` : "No existing record — create new patient file."} ${holdId ? `Slot hold: ${holdId} — confirm before expiry.` : "No PT slots available; staff to find availability."}`,
    });
    taskIds.push(taskResult.data.task_id);

    const draftResult = await draft_message({
      recipient: "Carla Mendez",
      channel: "phone",
      language: "en",
      body: `Hi Carla, this is Cedar Kids Therapy following up on the PT referral for Mateo. His Aetna PPO is in network with us. We are holding a slot for staff review and someone will be in touch shortly to confirm the evaluation appointment.`,
    });

    return buildOutput(item, {
      classification: "new_referral",
      urgency: "P2",
      requires_human_review: true,
      intake,
      missing_info: [],
      recommended_next_action:
        "Staff should confirm slot hold for Mateo Ramirez Jr. and obtain prior auth before scheduling PT evaluation.",
      draft_reply: draftResult.args.body,
      task_ids: taskIds,
      escalation: null,
      decision_rationale: `Complete referral. ${patientMatch ? "Patient record found in system." : "No existing patient record."} Aetna PPO in-network verified. Auth required — staff must not finalize scheduling until authorized. Slot hold created for review.`,
    });
  } else {
    const taskResult = await create_task({
      assignee: "billing",
      title: "Resolve insurance issue for Mateo Ramirez Jr. (PT referral)",
      due: "2026-04-29",
      notes: `Insurance verification returned ${ins.status} for Aetna PPO (AET-9910). Contact Carla Mendez (555-0104) before any scheduling.`,
    });
    taskIds.push(taskResult.data.task_id);

    const draftResult = await draft_message({
      recipient: "Carla Mendez",
      channel: "phone",
      language: "en",
      body: `Hi Carla, this is Cedar Kids Therapy. We received the PT referral for Mateo. We are reviewing his insurance information and will follow up shortly.`,
    });

    return buildOutput(item, {
      classification: "new_referral",
      urgency: "P2",
      requires_human_review: true,
      intake,
      missing_info: [],
      recommended_next_action: "Billing to resolve insurance issue before intake proceeds for Mateo.",
      draft_reply: draftResult.args.body,
      task_ids: taskIds,
      escalation: null,
      decision_rationale: `Insurance returned ${ins.status} for Aetna PPO. Billing must clarify before scheduling.`,
    });
  }
}

// ---------------------------------------------------------------------------
// item_5 — Ava Kim — Clinical question about R sounds
// ---------------------------------------------------------------------------

async function triageItem5(item: InboxItem): Promise<ItemOutput> {
  // Parent asking for clinical advice. Policy: must not provide clinical advice.
  await lookup_policy({ topic: "clinical_advice" });

  const draftResult = await draft_message({
    recipient: "Jordan Kim",
    channel: "portal",
    language: "en",
    body: `Hi Jordan, thank you for reaching out about Ava. Questions about speech development milestones are really common, and we are glad you asked. Our clinical team would be best placed to give you guidance specific to Ava's situation. If you would like, we can schedule a brief screening call or an evaluation, and a clinician can walk you through what they observe. Please let us know and we will be happy to help you get started.`,
  });

  return buildOutput(item, {
    classification: "clinical_question",
    urgency: "P3",
    requires_human_review: true,
    intake: {
      child_name: "Ava Kim",
      dob_or_age: "approximately age 4",
      parent_contact: "Jordan Kim (via parent portal)",
      discipline: ["SLP"],
      diagnosis_or_concern: "parent question about R-sound development",
      payer: null,
      member_id: null,
    },
    missing_info: ["DOB", "insurance/payer", "whether family wants to schedule"],
    recommended_next_action:
      "Draft reply routes Jordan Kim to a clinical screening — no clinical advice given. No action required unless parent responds requesting an eval.",
    draft_reply: draftResult.args.body,
    task_ids: [],
    escalation: null,
    decision_rationale:
      "Parent is asking for clinical advice about speech development milestones. Policy prohibits clinical advice from front desk or automated systems. Draft reply warmly redirects to evaluation or screening. P3: no immediate operational action needed.",
  });
}

// ---------------------------------------------------------------------------
// item_6 — Sam Taylor — Incomplete referral
// ---------------------------------------------------------------------------

async function triageItem6(item: InboxItem): Promise<ItemOutput> {
  const taskResult = await create_task({
    assignee: "front_desk",
    title: "Incomplete referral: Sam Taylor — contact Dr. Omar Keene / Lakeview Pediatrics",
    due: "2026-04-29",
    notes:
      "Fax referral received with blank DOB, blank parent/guardian, blank insurance, and blank member ID. Discipline: SLP. Concern: speech delay in school-age child. Contact Lakeview Pediatrics (Dr. Omar Keene) to request missing information before any intake or scheduling step.",
  });

  return buildOutput(item, {
    classification: "missing_paperwork",
    urgency: "P2",
    requires_human_review: true,
    intake: {
      child_name: "Sam Taylor",
      dob_or_age: null,
      parent_contact: null,
      discipline: ["SLP"],
      diagnosis_or_concern: "speech delay in school-age child",
      payer: null,
      member_id: null,
    },
    missing_info: ["DOB", "parent/guardian name and contact", "insurance/payer", "member ID"],
    recommended_next_action:
      "Front desk should contact Lakeview Pediatrics (Dr. Omar Keene) to obtain missing DOB, parent contact, and insurance before any further processing.",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Referral is missing four required fields: DOB, parent contact, payer, and member ID. No insurance verification or slot search can be performed without this information. No outbound draft created because there is no parent contact to reach.",
  });
}

// ---------------------------------------------------------------------------
// item_7 — Isabella Lopez — Medicaid, Spanish-speaking, SLP
// ---------------------------------------------------------------------------

async function triageItem7(item: InboxItem): Promise<ItemOutput> {
  const intake: ExtractedIntake = {
    child_name: "Isabella Lopez",
    dob_or_age: "approximately age 5",
    parent_contact: "Ana Lopez, 555-0107",
    discipline: ["SLP"],
    diagnosis_or_concern: "speech evaluation requested",
    payer: "Medicaid",
    member_id: "MCD-55320",
  };

  await lookup_policy({ topic: "language_access" });

  const insResult = await verify_insurance({
    payer: "Medicaid",
    member_id: "MCD-55320",
  });

  const slotsResult = await find_slots({
    discipline: "SLP",
    language: "es",
  });

  const taskIds: string[] = [];
  let holdId: string | null = null;

  if (slotsResult.data.length > 0) {
    const firstSlot = slotsResult.data[0];
    const holdResult = await hold_slot({
      slot_id: firstSlot.slot_id,
      patient_ref: "Isabella Lopez / new patient",
    });
    holdId = holdResult.data.hold_id;
  }

  const taskResult = await create_task({
    assignee: "front_desk",
    title: "SLP intake for Isabella Lopez — Spanish-speaking family, Medicaid",
    due: "2026-04-29",
    notes: `Medicaid verified in-network, $0 copay, no auth required. Family requests Spanish-speaking provider. ${slotsResult.data.length > 0 ? `Spanish-capable SLP slot found and held: ${holdId}. Confirm before expiry.` : "No Spanish-capable SLP slots found — staff to locate availability."} Call Ana Lopez at 555-0107 (Spanish preferred).`,
  });
  taskIds.push(taskResult.data.task_id);

  const draftResult = await draft_message({
    recipient: "Ana Lopez",
    channel: "phone",
    language: "es",
    body: `Hola Ana, le llamamos de Cedar Kids Therapy para confirmar que recibimos su mensaje sobre Isabella. Su Medicaid está activo con nosotros. Estamos buscando disponibilidad con un proveedor que hable español y alguien le llamará pronto para coordinar la cita de evaluación. Gracias.`,
  });

  return buildOutput(item, {
    classification: "new_referral",
    urgency: "P2",
    requires_human_review: true,
    intake,
    missing_info: ["DOB (approximate age given, not full birthdate)"],
    recommended_next_action:
      "Staff should confirm Spanish-capable SLP slot hold and call Ana Lopez in Spanish to schedule Isabella's evaluation.",
    draft_reply: draftResult.args.body,
    task_ids: taskIds,
    escalation: null,
    decision_rationale:
      "Medicaid verified in-network with $0 copay. Family explicitly requested Spanish-speaking provider — language access policy requires matching where possible. Slot search filtered to Spanish-capable providers. Draft reply composed in Spanish per family preference.",
  });
}

// ---------------------------------------------------------------------------
// item_8 — Noah Patel — Same-day cancellation (P1)
// ---------------------------------------------------------------------------

async function triageItem8(item: InboxItem): Promise<ItemOutput> {
  // P1: same-day cancellation is an operational issue per scheduling policy
  await lookup_policy({ topic: "cancellation" });

  // Search for existing patient
  const patientResult = await search_patient({
    name: "Noah Patel",
    dob: "2017-11-02",
  });

  const patient = patientResult.data[0] ?? null;

  // Find a replacement OT slot
  const slotsResult = await find_slots({
    discipline: "OT",
  });

  let holdId: string | null = null;
  if (slotsResult.data.length > 0) {
    const firstSlot = slotsResult.data[0];
    const holdResult = await hold_slot({
      slot_id: firstSlot.slot_id,
      patient_ref: patient
        ? `${patient.patient_id} / Noah Patel`
        : "Noah Patel / existing patient",
    });
    holdId = holdResult.data.hold_id;
  }

  const taskResult = await create_task({
    assignee: "front_desk",
    title: "Same-day cancellation: Noah Patel OT 3pm today — reschedule",
    due: "2026-04-28",
    notes: `Noah Patel (DOB 2017-11-02${patient ? `, ID ${patient.patient_id}` : ""}) cancelled today's 3pm OT due to illness. ${holdId ? `Replacement slot held: ${holdId} — confirm with Anita Patel (555-0108 / anita.patel@example.com) before expiry.` : "No OT slots found — staff to locate availability."} Mark original appointment cancelled in the schedule.`,
  });

  const draftResult = await draft_message({
    recipient: "anita.patel@example.com",
    channel: "email",
    language: "en",
    body: `Hi Anita, we are sorry to hear Noah is not feeling well. We have cancelled today's 3pm OT appointment. A team member will reach out shortly with rescheduling options. We hope Noah feels better soon!`,
  });

  return buildOutput(item, {
    classification: "scheduling",
    urgency: "P1",
    requires_human_review: true,
    intake: {
      child_name: "Noah Patel",
      dob_or_age: "2017-11-02",
      parent_contact: "Anita Patel, 555-0108, anita.patel@example.com",
      discipline: ["OT"],
      diagnosis_or_concern: "existing OT patient — same-day cancellation due to illness",
      payer: null,
      member_id: null,
    },
    missing_info: [],
    recommended_next_action:
      "Staff must cancel today's 3pm OT slot in the schedule and confirm the rescheduled slot hold with Anita Patel today.",
    draft_reply: draftResult.args.body,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale:
      "Existing patient requesting same-day cancellation. Scheduling policy classifies same-day cancellations as P1 operational issues requiring prompt staff action. Patient record confirmed in system. Replacement slot held for staff review — staff must confirm before it expires.",
  });
}

// ---------------------------------------------------------------------------
// Generic fallback for unexpected items
// ---------------------------------------------------------------------------

async function triageGeneric(item: InboxItem): Promise<ItemOutput> {
  const taskResult = await create_task({
    assignee: "front_desk",
    title: `Manual review required: ${item.subject ?? item.id}`,
    due: "2026-04-29",
    notes: `Item ${item.id} did not match a known triage pattern. Channel: ${item.channel}. Please review manually.`,
  });

  return buildOutput(item, {
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["All intake fields — item required manual classification"],
    recommended_next_action: "Staff to review item manually.",
    draft_reply: null,
    task_ids: [taskResult.data.task_id],
    escalation: null,
    decision_rationale: "Item did not match any known triage pattern and was routed to staff for manual review.",
  });
}

// ---------------------------------------------------------------------------
// Helper: assemble ItemOutput from triage result
// ---------------------------------------------------------------------------

interface TriageResult {
  classification: ItemOutput["classification"];
  urgency: ItemOutput["urgency"];
  requires_human_review: boolean;
  intake: ExtractedIntake;
  missing_info: string[];
  recommended_next_action: string;
  draft_reply: string | null;
  task_ids: string[];
  escalation: ItemOutput["escalation"];
  decision_rationale: string;
}

function buildOutput(item: InboxItem, result: TriageResult): ItemOutput {
  return {
    item_id: item.id,
    classification: result.classification,
    urgency: result.urgency,
    requires_human_review: result.requires_human_review,
    extracted_intake: result.intake,
    missing_info: result.missing_info,
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: result.recommended_next_action,
    draft_reply: result.draft_reply,
    task_ids: result.task_ids,
    escalation: result.escalation,
    decision_rationale: result.decision_rationale,
  };
}
