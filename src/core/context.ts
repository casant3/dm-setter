import type { Store } from "@/lib/store/store";
import type {
  ConversationChunk,
  ConversationEvent,
  CredibilityAsset,
  Lead,
  LeadMemory,
  Message,
} from "@/lib/types";

export const WINNER_OUTCOMES = ["📞 Onboarding Call", "📞 Discovery Call"];
export const FAILURE_OUTCOMES = ["❌ Not Interested", "⚫ No show"];

export type LeadContext = {
  lead: Lead;
  memory: LeadMemory | null;
  recentMessages: Message[];
  events: ConversationEvent[];
  credibility: CredibilityAsset[];
  similarWinners: ConversationChunk[];
  similarLosses: ConversationChunk[];
  newMessage: string;
};

/**
 * Assembles permanent lead memory plus a short recent-message working context,
 * and retrieves both similar winners and similar failures.
 */
export async function loadLeadContext(
  store: Store,
  leadId: string,
  newMessage: string,
): Promise<LeadContext> {
  const lead = await store.getLead(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);

  const [recent, memory, events, credibility] = await Promise.all([
    store.recentMessages(lead.id, 16),
    store.getMemory(lead.id),
    store.listEvents(lead.id, 12),
    store.listCredibility(30),
  ]);

  const queryText = [lead.industry, lead.niche, lead.commercial_goal, lead.media_gap, newMessage]
    .filter(Boolean)
    .join(" | ");

  const [similarWinners, similarLosses] = await Promise.all([
    store.matchChunks(queryText, WINNER_OUTCOMES, 4),
    store.matchChunks(queryText, FAILURE_OUTCOMES, 3),
  ]);

  return {
    lead,
    memory,
    recentMessages: [...recent].reverse(),
    events,
    credibility,
    similarWinners,
    similarLosses,
    newMessage,
  };
}

export async function loadLeadContextByHandle(
  store: Store,
  handle: string,
  newMessage: string,
): Promise<LeadContext> {
  const lead = await store.getLeadByHandle(handle);
  if (!lead) throw new Error(`Lead not found: ${handle}`);
  return loadLeadContext(store, lead.id, newMessage);
}

/** The exact JSON blob handed to every pass of the pipeline. */
export function compactContext(ctx: LeadContext): string {
  return JSON.stringify(
    {
      lead: ctx.lead,
      lead_memory: ctx.memory,
      recent_messages: ctx.recentMessages,
      important_events: ctx.events,
      approved_credibility_assets: ctx.credibility,
      similar_successful_examples: ctx.similarWinners.map((x) => ({
        outcome: x.outcome,
        stage: x.stage,
        content: x.content,
        metadata: x.metadata,
        similarity: x.similarity,
      })),
      similar_failed_examples: ctx.similarLosses.map((x) => ({
        outcome: x.outcome,
        stage: x.stage,
        content: x.content,
        metadata: x.metadata,
        similarity: x.similarity,
      })),
      prospect_new_message: ctx.newMessage,
    },
    null,
    2,
  );
}
