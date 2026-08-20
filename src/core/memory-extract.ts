import { makeItem, mergeItems } from "@/core/memory";
import { verifyQuote } from "@/core/qualification-evidence";
import type { LeadMemory, MemoryItem, Message } from "@/lib/types";

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
  relationship_summary: string | null;
  communication_style: string | null;
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
  /** Items whose quote was found in the conversation. */
  facts: number;
  /** Items whose quote was not found — kept as inferences. */
  inferences: number;
};

function toItems(
  items: ExtractedItem[] | undefined,
  messages: Message[],
  stats: ExtractionStats,
): MemoryItem[] {
  const out: MemoryItem[] = [];
  for (const item of items ?? []) {
    const value = item?.value?.trim();
    if (!value) continue;
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
): { patch: ExtractionPatch; stats: ExtractionStats } {
  const verified = new Set(memory?.verified_fields ?? []);
  const stats: ExtractionStats = { facts: 0, inferences: 0 };
  const patch: ExtractionPatch = { lead_id: leadId, updated_at: new Date().toISOString() };

  for (const field of EXTRACTED_FIELDS) {
    if (verified.has(field)) continue;
    const items = toItems(extraction[field], messages, stats);
    if (items.length === 0) continue;
    patch[field] = mergeItems(memory?.[field] ?? [], items);
  }

  const summary = extraction.relationship_summary?.trim();
  if (summary && !verified.has("relationship_summary")) patch.relationship_summary = summary;

  const style = extraction.communication_style?.trim();
  if (style && !verified.has("communication_style")) patch.communication_style = style;

  return { patch, stats };
}

/** The conversation, rendered for the extraction prompt. */
export function transcriptFor(messages: Message[], limit = 60): string {
  return messages
    .slice(-limit)
    .map((m) => `${m.sender === "setter" ? "Cassey" : "Prospect"}: ${m.message_text}`)
    .join("\n");
}

export const EXTRACTION_INSTRUCTIONS = `Extract durable, long-term memory from this conversation.

Record only things worth remembering months from now: what they are building, what they are working toward personally, what is in their way, what they have said about media, what they objected to, what either side committed to, and the people, companies and products they named.

Every item MUST carry the exact words from the conversation it came from, copied verbatim into "quote". Quotes are checked against the real messages: an item whose quote cannot be found is kept only as a low-confidence inference. Do not paraphrase into the quote field, and never invent one.

Do not record: pleasantries, anything we said about ourselves, anything already obvious from the profile, or your own opinion of the prospect. If a field has nothing worth keeping, return an empty list.`;
