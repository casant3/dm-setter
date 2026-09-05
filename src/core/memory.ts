import { assessUnderstanding, type UnderstandingAssessment } from "@/core/understanding";
import type { LeadMemory, MemoryItem, Message, Provenance, Strategy } from "@/lib/types";

/**
 * Permanent lead memory.
 *
 * The goal is that a lead can be picked up months later and still carry what was
 * said, asked, offered and objected to — without depending on the last N
 * messages. Updates are incremental and additive: good information is never
 * rewritten just because a new exchange happened, and anything a human has
 * verified is never overwritten automatically.
 */

/** Memory fields holding lists of remembered items. */
export const MEMORY_LIST_FIELDS = [
  "facts_known",
  "research_facts",
  "businesses",
  "goals",
  "personal_goals",
  "pain_points",
  "interests",
  "objections",
  "media_history",
  "opportunities_identified",
  "questions_already_asked",
  "offers_explained",
  "ctas_already_used",
  "buying_signals",
  "timing_constraints",
  "followup_commitments",
  "key_entities",
] as const;

export type MemoryListField = (typeof MEMORY_LIST_FIELDS)[number];

export function emptyMemory(leadId: string): LeadMemory {
  const lists = Object.fromEntries(MEMORY_LIST_FIELDS.map((f) => [f, [] as MemoryItem[]])) as Record<
    MemoryListField,
    MemoryItem[]
  >;
  return {
    lead_id: leadId,
    relationship_summary: null,
    ...lists,
    communication_style: null,
    current_strategy: null,
    service_explained: false,
    service_explained_at: null,
    service_explained_count: 0,
    service_understanding: 0,
    service_understanding_evidence: [],
    verified_fields: [],
    updated_at: null,
  } as LeadMemory;
}

/**
 * Reads a narrative field, whatever shape it is stored in.
 *
 * `relationship_summary` and `communication_style` were plain text before they
 * carried provenance. A bare string is an unattributed model interpretation, so
 * that is exactly what it becomes.
 */
export function narrativeItem(value: unknown): MemoryItem | null {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    return {
      value: text,
      provenance: "inference",
      confidence: 0.4,
      source_message_id: null,
      quote: null,
      source_ref: null,
      recorded_at: new Date(0).toISOString(),
      verified: false,
    };
  }
  const item = value as MemoryItem;
  return typeof item?.value === "string" ? item : null;
}

export function makeItem(
  value: string,
  provenance: Provenance,
  options: {
    confidence?: number;
    source_message_id?: string | null;
    quote?: string | null;
    source_ref?: string | null;
    verified?: boolean;
  } = {},
): MemoryItem {
  return {
    value: value.trim(),
    provenance,
    confidence: options.verified ? 1 : (options.confidence ?? (provenance === "fact" ? 0.9 : provenance === "research" ? 0.7 : 0.6)),
    source_message_id: options.source_message_id ?? null,
    quote: options.quote ?? null,
    source_ref: options.source_ref ?? null,
    recorded_at: new Date().toISOString(),
    verified: options.verified ?? false,
  };
}

function sameValue(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
  return norm(a) === norm(b);
}

/**
 * Adds an item unless an equivalent one is already remembered.
 *
 * A human-verified entry always wins: an automatic update can raise confidence on
 * it but never replace its text or downgrade it.
 */
export function mergeItem(list: MemoryItem[], incoming: MemoryItem): MemoryItem[] {
  const idx = list.findIndex((existing) => sameValue(existing.value, incoming.value));
  if (idx === -1) return [...list, incoming];

  const existing = list[idx];
  if (existing.verified && incoming.provenance !== "human") {
    // Corroboration raises confidence but leaves the verified text alone.
    const next = [...list];
    next[idx] = { ...existing, confidence: Math.max(existing.confidence, incoming.confidence) };
    return next;
  }
  if (incoming.provenance === "human") {
    const next = [...list];
    next[idx] = { ...incoming, verified: true, confidence: 1 };
    return next;
  }
  // Prefer the better-evidenced version, keeping the earliest recorded_at.
  const winner = incoming.confidence > existing.confidence ? incoming : existing;
  const next = [...list];
  next[idx] = { ...winner, recorded_at: existing.recorded_at };
  return next;
}

export function mergeItems(list: MemoryItem[], incoming: MemoryItem[]): MemoryItem[] {
  return incoming.reduce((acc, item) => mergeItem(acc, item), list);
}

// ---------------------------------------------------------------------------
// Deterministic extraction from an exchange
// ---------------------------------------------------------------------------

/** Splits a DM into the questions it asks, so they are never asked twice. */
export function extractQuestions(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith("?") && s.length > 8);
}

/** Wording that means we have just described the commercial model. */
const EXPLANATION_PATTERNS = [
  /\bwe (help|work with) (our )?clients\b/i,
  /\bthat'?s something we (help|do for) (clients|people)\b/i,
  /\bwe handle\b.*\b(placement|media|podcast|press)\b/i,
  /\bisn'?t (me )?invit(ing|e) you\b/i,
  /\bnot a (guest|podcast) (invite|invitation|spot)\b/i,
  /\bthis is what we do for clients\b/i,
  /\bour clients\b/i,
];

export function messageExplainsService(text: string): boolean {
  return EXPLANATION_PATTERNS.some((re) => re.test(text));
}

const BUYING_SIGNAL_PATTERNS = [
  { re: /\bwhat does (this|working with you) (look like|involve)\b/i, label: "Asked what working together looks like" },
  { re: /\bhow much\b|\bpricing\b|\bcost\b|\brates?\b/i, label: "Asked about price" },
  { re: /\b(let'?s|happy to) (talk|chat|jump on|hop on)\b/i, label: "Offered to talk" },
  { re: /\b(send|share) (me )?(more )?(info|details|deck)\b/i, label: "Asked for more information" },
  { re: /\bi'?m interested\b/i, label: "Stated interest" },
];

const TIMING_PATTERNS = [
  { re: /\b(next|this) (week|month|quarter)\b/i, label: "Referenced a near-term timeframe" },
  { re: /\b(in|by) (january|february|march|april|may|june|july|august|september|october|november|december)\b/i, label: "Named a month" },
  { re: /\bq[1-4]\b/i, label: "Named a quarter" },
  { re: /\b(launch|raise|round|opening|release)\b.*\b(in|on|by)\b/i, label: "Tied a deadline to a launch or raise" },
];

export type ExchangeInput = {
  strategy: Strategy;
  /** The message the setter actually sent. */
  sentMessage: string;
  /** All prospect messages known for this lead, oldest first. */
  prospectMessages?: Pick<Message, "id" | "message_text" | "sent_at">[];
  /** The prospect's newest message, if it is not already in the list. */
  latestProspectMessage?: string;
};

export type MemoryUpdate = Partial<LeadMemory> & { lead_id: string };

/**
 * Produces an incremental memory patch after an exchange actually happened.
 *
 * Deterministic by design: everything here is derived from text we can point at,
 * so it is cheap, repeatable and testable. Richer narrative extraction is a
 * separate, optional model pass (see `memory-extract.ts`).
 */
export function applyExchangeToMemory(
  memory: LeadMemory | null,
  leadId: string,
  input: ExchangeInput,
): MemoryUpdate {
  const base = memory ?? emptyMemory(leadId);
  const verified = new Set(base.verified_fields ?? []);
  const { strategy, sentMessage } = input;

  const patch: MemoryUpdate = { lead_id: leadId, updated_at: new Date().toISOString() };

  // --- what we asked -------------------------------------------------------
  if (!verified.has("questions_already_asked")) {
    const questions = extractQuestions(sentMessage).map((q) => makeItem(q, "fact", { confidence: 1 }));
    patch.questions_already_asked = mergeItems(base.questions_already_asked ?? [], questions);
  }

  // --- did we explain the service this time? -------------------------------
  const explainedNow = messageExplainsService(sentMessage) || strategy.should_explain_service || strategy.service_confusion;
  if (explainedNow) {
    patch.service_explained = true;
    patch.service_explained_at = new Date().toISOString();
    patch.service_explained_count = (base.service_explained_count ?? 0) + 1;
    if (!verified.has("offers_explained")) {
      patch.offers_explained = mergeItem(
        base.offers_explained ?? [],
        makeItem("Explained that this is a professional paid media/authority service", "fact", { confidence: 1 }),
      );
    }
  }

  // --- CTAs ---------------------------------------------------------------
  if (strategy.call_ready && !verified.has("ctas_already_used")) {
    patch.ctas_already_used = mergeItem(
      base.ctas_already_used ?? [],
      makeItem("Offered a call with Avo", "fact", { confidence: 1 }),
    );
  }

  // --- understanding, judged from the prospect's own words -----------------
  const prospectMessages = [...(input.prospectMessages ?? [])];
  if (input.latestProspectMessage?.trim()) {
    prospectMessages.push({ id: "", message_text: input.latestProspectMessage, sent_at: new Date().toISOString() });
  }

  const serviceExplained = Boolean(patch.service_explained ?? base.service_explained);
  const assessment = assessUnderstanding(prospectMessages, serviceExplained);

  if (!verified.has("service_understanding")) {
    patch.service_understanding = assessment.level;
    patch.service_understanding_evidence = assessment.evidence;
  }

  if (assessment.confusion && !verified.has("objections")) {
    patch.objections = mergeItem(
      base.objections ?? [],
      makeItem(assessment.confusion.reason, "fact", {
        confidence: 1,
        source_message_id: assessment.confusion.message_id,
        quote: assessment.confusion.quote,
      }),
    );
  }

  // --- signals from the prospect ------------------------------------------
  const buying: MemoryItem[] = [];
  const timing: MemoryItem[] = [];
  for (const msg of prospectMessages) {
    const text = msg.message_text ?? "";
    for (const { re, label } of BUYING_SIGNAL_PATTERNS) {
      if (re.test(text)) buying.push(makeItem(label, "fact", { source_message_id: msg.id || null, quote: text.slice(0, 200), confidence: 0.9 }));
    }
    for (const { re, label } of TIMING_PATTERNS) {
      if (re.test(text)) timing.push(makeItem(label, "inference", { source_message_id: msg.id || null, quote: text.slice(0, 200), confidence: 0.6 }));
    }
  }
  if (buying.length && !verified.has("buying_signals")) {
    patch.buying_signals = mergeItems(base.buying_signals ?? [], buying);
  }
  if (timing.length && !verified.has("timing_constraints")) {
    patch.timing_constraints = mergeItems(base.timing_constraints ?? [], timing);
  }

  // --- current strategy ----------------------------------------------------
  if (!verified.has("current_strategy")) patch.current_strategy = strategy.next_objective;

  return patch;
}

/**
 * Applies a human correction. The touched fields are marked verified so later
 * automatic updates leave them alone.
 */
export function applyHumanCorrection(
  memory: LeadMemory | null,
  leadId: string,
  corrections: Partial<Record<MemoryListField, string[]>> & {
    relationship_summary?: string | null;
    communication_style?: string | null;
    service_understanding?: number | null;
    service_explained?: boolean | null;
  },
): MemoryUpdate {
  const base = memory ?? emptyMemory(leadId);
  const verified = new Set(base.verified_fields ?? []);
  const patch: MemoryUpdate = { lead_id: leadId, updated_at: new Date().toISOString() };

  for (const field of MEMORY_LIST_FIELDS) {
    const values = corrections[field];
    if (!values) continue;
    // A correction replaces the field wholesale — the human has seen the list.
    patch[field] = values.map((v) => makeItem(v, "human", { verified: true, confidence: 1 }));
    verified.add(field);
  }

  // A person writing the summary makes it a human-verified item rather than the
  // model's reading — and automatic extraction then leaves it alone entirely.
  if (corrections.relationship_summary !== undefined) {
    patch.relationship_summary = corrections.relationship_summary
      ? makeItem(corrections.relationship_summary, "human", { verified: true, confidence: 1 })
      : null;
    verified.add("relationship_summary");
  }
  if (corrections.communication_style !== undefined) {
    patch.communication_style = corrections.communication_style
      ? makeItem(corrections.communication_style, "human", { verified: true, confidence: 1 })
      : null;
    verified.add("communication_style");
  }
  if (corrections.service_understanding !== undefined && corrections.service_understanding !== null) {
    patch.service_understanding = Math.max(0, Math.min(2, corrections.service_understanding));
    verified.add("service_understanding");
  }
  if (corrections.service_explained !== undefined && corrections.service_explained !== null) {
    patch.service_explained = corrections.service_explained;
    verified.add("service_explained");
  }

  patch.verified_fields = [...verified];
  return patch;
}

/** Re-derives understanding from the full prospect history, ignoring the window. */
export function recomputeUnderstanding(
  memory: LeadMemory | null,
  prospectMessages: Pick<Message, "id" | "message_text" | "sent_at">[],
): UnderstandingAssessment {
  return assessUnderstanding(prospectMessages, Boolean(memory?.service_explained));
}
