import { makeItem, mergeItems, narrativeItem } from "@/core/memory";
import { verifyQuote } from "@/core/qualification-evidence";
import type { ExtractionState, LeadMemory, MemoryItem, Message } from "@/lib/types";

/**
 * The model-driven half of long-term memory.
 *
 * The deterministic pass records what can be pattern-matched: questions asked,
 * CTAs used, buying signals, timing. It cannot record "he mentioned his
 * co-founder left and he is rebuilding the team" — the things that make a
 * follow-up months later sound like it came from someone who was listening.
 *
 * This pass asks the model for those, and then refuses to take its word for
 * them: every item must carry the words it came from, and the quote is checked
 * verbatim against the real messages. A found quote is a fact. An unfound quote
 * is an inference at low confidence, kept but visibly weaker. Human-verified
 * fields are never touched by either.
 */

export type ExtractedItem = { value: string; quote: string };

export type ExtractedMemory = {
  /** The model's reading of the relationship, with anything it can point at. */
  relationship_summary: ExtractedItem | null;
  communication_style: ExtractedItem | null;
  businesses: ExtractedItem[];
  goals: ExtractedItem[];
  personal_goals: ExtractedItem[];
  facts_known: ExtractedItem[];
  pain_points: ExtractedItem[];
  interests: ExtractedItem[];
  media_history: ExtractedItem[];
  opportunities_identified: ExtractedItem[];
  key_entities: ExtractedItem[];
  objections: ExtractedItem[];
  followup_commitments: ExtractedItem[];
};

/** The list fields this pass is allowed to write. */
export const EXTRACTED_FIELDS = [
  "businesses",
  "goals",
  "personal_goals",
  "facts_known",
  "pain_points",
  "interests",
  "media_history",
  "opportunities_identified",
  "key_entities",
  "objections",
  "followup_commitments",
] as const;
export type ExtractedField = (typeof EXTRACTED_FIELDS)[number];

export type ExtractionPatch = Partial<LeadMemory> & { lead_id: string };

export type ExtractionStats = {
  /** Messages this run actually looked at. */
  messages_considered: number;
  /** Items the model offered. */
  proposed: number;
  /** Items whose quote was found in the conversation. */
  facts: number;
  /** Items whose quote was not found — kept as inferences. */
  inferences: number;
  /** Items already remembered, so nothing was added. */
  duplicates_ignored: number;
  /** Fields skipped because a human had corrected them. */
  human_fields_skipped: number;
};

export function emptyStats(): ExtractionStats {
  return {
    messages_considered: 0,
    proposed: 0,
    facts: 0,
    inferences: 0,
    duplicates_ignored: 0,
    human_fields_skipped: 0,
  };
}

function toItems(
  items: ExtractedItem[] | undefined,
  messages: Message[],
  stats: ExtractionStats,
): MemoryItem[] {
  const out: MemoryItem[] = [];
  for (const item of items ?? []) {
    const value = item?.value?.trim();
    if (!value) continue;
    stats.proposed += 1;
    const quote = item.quote?.trim() ?? "";
    const verified = quote ? verifyQuote(quote, messages) : { found: false, message_id: null };
    if (verified.found) {
      stats.facts += 1;
      out.push(makeItem(value, "fact", { confidence: 0.9, quote, source_message_id: verified.message_id }));
    } else {
      stats.inferences += 1;
      out.push(makeItem(value, "inference", { confidence: 0.4, quote: quote || null }));
    }
  }
  return out;
}

/**
 * Turns an extraction into a memory patch.
 *
 * Fields a human has verified are skipped entirely: a correction is the end of
 * the argument, not an input to the next round of guessing.
 */
export function memoryPatchFromExtraction(
  memory: LeadMemory | null,
  leadId: string,
  extraction: ExtractedMemory,
  messages: Message[],
  options: { messagesConsidered?: number } = {},
): { patch: ExtractionPatch; stats: ExtractionStats } {
  const verified = new Set(memory?.verified_fields ?? []);
  const stats: ExtractionStats = { ...emptyStats(), messages_considered: options.messagesConsidered ?? messages.length };
  const patch: ExtractionPatch = { lead_id: leadId, updated_at: new Date().toISOString() };

  for (const field of EXTRACTED_FIELDS) {
    if (verified.has(field)) {
      if ((extraction[field]?.length ?? 0) > 0) stats.human_fields_skipped += 1;
      continue;
    }
    const items = toItems(extraction[field], messages, stats);
    if (items.length === 0) continue;
    const existing = memory?.[field] ?? [];
    const merged = mergeItems(existing, items);
    // Anything that did not lengthen the list was already remembered.
    stats.duplicates_ignored += items.length - (merged.length - existing.length);
    patch[field] = merged;
  }

  // The narrative fields are the model's interpretation of the relationship, not
  // anything the prospect said. They are stored as inferences with whatever the
  // model could point at, so that context can present them as a reading rather
  // than as fact — and a human correction is never overwritten by one.
  patch.relationship_summary = narrativeFrom(extraction.relationship_summary, memory?.relationship_summary ?? null, verified.has("relationship_summary"), messages, stats);
  if (patch.relationship_summary === undefined) delete patch.relationship_summary;

  patch.communication_style = narrativeFrom(extraction.communication_style, memory?.communication_style ?? null, verified.has("communication_style"), messages, stats);
  if (patch.communication_style === undefined) delete patch.communication_style;

  return { patch, stats };
}

/**
 * Turns a model-written summary into a memory item.
 *
 * Always an inference: "prospect trusts Cassey" is a judgement even when the
 * conversation is warm. A quote that checks out raises the confidence and
 * records where it came from; it never promotes the reading to a fact, and a
 * human-verified summary is left exactly as the person wrote it.
 */
function narrativeFrom(
  extracted: ExtractedItem | null,
  existing: MemoryItem | null,
  isVerified: boolean,
  messages: Message[],
  stats: ExtractionStats,
): MemoryItem | null | undefined {
  const value = extracted?.value?.trim();
  if (!value) return undefined;
  if (isVerified) {
    stats.human_fields_skipped += 1;
    return undefined;
  }
  const current = narrativeItem(existing);
  if (current?.verified) {
    stats.human_fields_skipped += 1;
    return undefined;
  }

  stats.proposed += 1;
  const quote = extracted?.quote?.trim() ?? "";
  const support = quote ? verifyQuote(quote, messages) : { found: false, message_id: null };
  stats.inferences += 1;

  return makeItem(value, "inference", {
    // Supported by something they actually said, but still a reading of it.
    confidence: support.found ? 0.6 : 0.35,
    quote: support.found ? quote : null,
    source_message_id: support.message_id,
  });
}

// ---------------------------------------------------------------------------
// Incremental extraction
// ---------------------------------------------------------------------------

/** How many earlier messages to keep for context around the new ones. */
export const EXTRACTION_CONTEXT_WINDOW = 4;

export type ExtractionInput = {
  /** The messages this run should actually reason about. */
  newMessages: Message[];
  /** Those messages plus a little preceding context, rendered. */
  transcript: string;
  /** What is already remembered, so the model does not offer it again. */
  alreadyKnown: string;
  /** True when there is nothing new and the model should not be called at all. */
  skip: boolean;
  state: ExtractionState;
};

function itemLines(items: MemoryItem[] | undefined, label: string): string[] {
  if (!items?.length) return [];
  return [`${label}: ${items.map((i) => i.value).join("; ")}`];
}

/**
 * Works out what actually needs extracting.
 *
 * Re-sending the whole transcript on every exchange asks the model to re-derive
 * memory it already produced — slower, more expensive, and a fresh chance to
 * paraphrase a stable fact into a slightly different one. Only messages since
 * the last run are new; a short window before them is kept so the new ones can
 * still be interpreted, and everything already remembered is listed so it is not
 * proposed twice.
 */
export function buildExtractionInput(memory: LeadMemory | null, messages: Message[]): ExtractionInput {
  const state = memory?.extraction_state ?? null;
  const lastId = state?.last_message_id ?? null;

  const lastIndex = lastId ? messages.findIndex((m) => m.id === lastId) : -1;
  const newMessages = lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;

  const contextStart = Math.max(0, (lastIndex >= 0 ? lastIndex + 1 : 0) - EXTRACTION_CONTEXT_WINDOW);
  const window = messages.slice(contextStart, lastIndex >= 0 ? undefined : messages.length);

  const known = [
    ...itemLines(memory?.businesses, "Businesses"),
    ...itemLines(memory?.goals, "Goals"),
    ...itemLines(memory?.personal_goals, "Personal goals"),
    ...itemLines(memory?.pain_points, "Pain points"),
    ...itemLines(memory?.media_history, "Media history"),
    ...itemLines(memory?.objections, "Objections"),
    ...itemLines(memory?.key_entities, "People, companies and products"),
    ...itemLines(memory?.followup_commitments, "Commitments"),
  ];

  const last = messages[messages.length - 1] ?? null;

  return {
    newMessages,
    transcript: renderMessages(window),
    alreadyKnown: known.length ? known.join("\n") : "Nothing is remembered about this lead yet.",
    skip: newMessages.length === 0,
    state: {
      last_message_id: last?.id ?? null,
      last_message_at: last?.sent_at ?? null,
      messages_considered: (state?.messages_considered ?? 0) + newMessages.length,
      last_run_at: new Date().toISOString(),
    },
  };
}

function renderMessages(messages: Message[]): string {
  return messages.map((m) => `${m.sender === "setter" ? "Cassey" : "Prospect"}: ${m.message_text}`).join("\n");
}

/** The whole conversation, rendered. Used for a first, full extraction. */
export function transcriptFor(messages: Message[], limit = 60): string {
  return renderMessages(messages.slice(-limit));
}

export const EXTRACTION_INSTRUCTIONS = `Extract durable, long-term memory from this conversation.

Record only things worth remembering months from now: what they are building, what they are working toward personally, what is in their way, what they have said about media, what they objected to, what either side committed to, and the people, companies and products they named.

Every item MUST carry the exact words from the conversation it came from, copied verbatim into "quote". Quotes are checked against the real messages: an item whose quote cannot be found is kept only as a low-confidence inference. Do not paraphrase into the quote field, and never invent one.

relationship_summary and communication_style are your own reading of the conversation rather than anything they said. Give the words that best support each one in its "quote"; where nothing supports it, say so plainly rather than overstating it. Both are stored as interpretations and are never treated as fact.

Do not record: pleasantries, anything we said about ourselves, anything already obvious from the profile, or your own opinion of the prospect. If a field has nothing worth keeping, return an empty list.

You may be given what is already remembered about this lead. Do not repeat any of it. Extract only what is new in the messages shown.`;
