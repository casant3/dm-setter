import { rankCredibility } from "@/core/credibility";
import { recomputeUnderstanding } from "@/core/memory";
import { CASSEY, buildQueryText, rerankAndBucket } from "@/core/retrieval";
import type { Store } from "@/lib/store/store";
import type {
  ConversationEvent,
  CredibilityAsset,
  Lead,
  LeadMemory,
  MemoryItem,
  Message,
  RetrievedExamples,
  Strategy,
} from "@/lib/types";
import type { UnderstandingAssessment } from "@/core/understanding";

/** Recent-message window. Anything important outside it must live in memory. */
export const RECENT_WINDOW = 16;
/** How many candidates to pull before reranking. Over-fetch, then narrow. */
export const RETRIEVAL_CANDIDATES = 24;

export type LeadContext = {
  lead: Lead;
  memory: LeadMemory | null;
  recentMessages: Message[];
  /** Every prospect message, used for understanding — not sent to the model. */
  allProspectMessages: Message[];
  events: ConversationEvent[];
  credibility: CredibilityAsset[];
  examples: RetrievedExamples;
  understanding: UnderstandingAssessment;
  newMessage: string;
  /** Populated once the strategy pass has run. */
  strategy?: Strategy;
};

/**
 * Loads everything the pipeline needs about one lead.
 *
 * Retrieval and credibility ranking depend on the strategy, so they run in a
 * second pass (`enrichContext`) once the strategist has produced one. The first
 * pass stays cheap: no embeddings are computed for a lead we may not act on.
 */
export async function loadLeadContext(store: Store, leadId: string, newMessage: string): Promise<LeadContext> {
  const lead = await store.getLead(leadId);
  if (!lead) throw new Error(`Lead not found: ${leadId}`);

  const [recent, memory, events, allMessages] = await Promise.all([
    store.recentMessages(lead.id, RECENT_WINDOW),
    store.getMemory(lead.id),
    store.listEvents(lead.id, 12),
    store.listMessages(lead.id),
  ]);

  const allProspectMessages = allMessages.filter((m) => m.sender === "prospect");
  const forUnderstanding = newMessage.trim()
    ? [...allProspectMessages, { id: "", message_text: newMessage, sent_at: new Date().toISOString() } as Message]
    : allProspectMessages;

  return {
    lead,
    memory,
    recentMessages: [...recent].reverse(),
    allProspectMessages,
    events,
    credibility: [],
    examples: { strong_winners: [], partial_wins: [], failures: [], voice_examples: [] },
    understanding: recomputeUnderstanding(memory, forUnderstanding),
    newMessage,
  };
}

/**
 * Second pass: retrieve and rank historical examples and credibility proof using
 * the strategy the strategist just produced.
 */
export async function enrichContext(
  store: Store,
  ctx: LeadContext,
  strategy: Strategy,
  options: { voiceSetter?: string } = {},
): Promise<LeadContext> {
  const queryText = buildQueryText(ctx.lead, strategy, ctx.newMessage);

  const [candidates, allCredibility] = await Promise.all([
    store.matchChunks(queryText, RETRIEVAL_CANDIDATES),
    store.listCredibility(60),
  ]);

  const examples = rerankAndBucket(candidates, {
    lead: ctx.lead,
    strategy,
    voiceSetter: options.voiceSetter ?? CASSEY,
  });

  return {
    ...ctx,
    strategy,
    examples,
    credibility: rankCredibility(allCredibility, ctx.lead, strategy),
  };
}

// ---------------------------------------------------------------------------
// Context serialisation
// ---------------------------------------------------------------------------

function itemValues(items: MemoryItem[] | undefined, limit = 12): string[] {
  return (items ?? [])
    .slice(-limit)
    .map((i) => (i.provenance === "inference" ? `${i.value} (inferred)` : i.value));
}

function summariseChunk(c: { outcome: string | null; outcome_tier: string | null; stage: string | null; niche: string | null; content: string; setter_name: string | null; match_reasons?: string[]; metadata: Record<string, unknown> | null }) {
  return {
    outcome: c.outcome,
    tier: c.outcome_tier,
    stage: c.stage,
    niche: c.niche,
    setter: c.setter_name,
    why_selected: c.match_reasons,
    what_happened: c.content,
    labels: c.metadata,
  };
}

/**
 * Builds the JSON context handed to each pass.
 *
 * Deliberately structured rather than a raw conversation dump: memory carries
 * what matters from outside the recent window, and each historical example is
 * labelled with what it proves so the writer cannot mistake a failure for a
 * template.
 */
export function compactContext(ctx: LeadContext): string {
  const m = ctx.memory;
  const recent = ctx.recentMessages.map((x) => ({
    sender: x.sender,
    text: x.message_text,
    at: x.sent_at,
    ...(x.is_objection ? { objection: true } : {}),
    ...(x.is_buying_signal ? { buying_signal: true } : {}),
  }));

  // Questions already asked also appear in memory; the recent window is the
  // authority for wording, so memory only carries the ones outside it.
  const recentText = recent.map((r) => r.text.toLowerCase()).join(" ");
  const olderQuestions = itemValues(m?.questions_already_asked, 30).filter(
    (q) => !recentText.includes(q.toLowerCase().slice(0, 24)),
  );

  return JSON.stringify(
    {
      lead_profile: {
        handle: ctx.lead.instagram_handle,
        name: ctx.lead.name,
        company: ctx.lead.company,
        job_title: ctx.lead.job_title,
        industry: ctx.lead.industry,
        niche: ctx.lead.niche,
        followers: ctx.lead.followers,
        location: ctx.lead.location,
        commercial_goal: ctx.lead.commercial_goal,
        media_gap: ctx.lead.media_gap,
        media_experience: ctx.lead.media_experience,
        authority_level: ctx.lead.authority_level,
        conversation_stage: ctx.lead.conversation_stage,
      },
      long_term_memory: m
        ? {
            relationship_summary: m.relationship_summary,
            businesses: itemValues(m.businesses),
            commercial_goals: itemValues(m.goals),
            personal_goals: itemValues(m.personal_goals),
            facts_known: itemValues(m.facts_known),
            pain_points: itemValues(m.pain_points),
            interests: itemValues(m.interests),
            media_history: itemValues(m.media_history),
            opportunities_identified: itemValues(m.opportunities_identified),
            key_entities: itemValues(m.key_entities),
            timing_constraints: itemValues(m.timing_constraints),
            followup_commitments: itemValues(m.followup_commitments),
            communication_style: m.communication_style,
            current_strategy: m.current_strategy,
          }
        : null,
      already_covered: {
        questions_already_asked_outside_recent_window: olderQuestions,
        offers_explained: itemValues(m?.offers_explained),
        ctas_already_used: itemValues(m?.ctas_already_used),
        objections_raised: itemValues(m?.objections),
        buying_signals_seen: itemValues(m?.buying_signals),
      },
      service_state: {
        service_explained: Boolean(m?.service_explained),
        service_explained_count: m?.service_explained_count ?? 0,
        service_understanding: ctx.understanding.level,
        understanding_evidence: ctx.understanding.evidence,
        service_confusion: ctx.understanding.confusion,
        commercial_clarity_needed: ctx.understanding.commercial_clarity_needed,
        note: "service_explained means WE explained it. service_understanding is evidenced only by the prospect's own words.",
        clarity_note:
          ctx.understanding.commercial_clarity_needed === null
            ? null
            : "They asked about cost before we made the commercial model clear. They do NOT hold a wrong premise about what we are, so do not correct one. State plainly that this is a paid service and what it does, then continue.",
      },
      qualification_state: ctx.strategy
        ? {
            stage: ctx.strategy.stage,
            qualification: ctx.strategy.qualification,
            total_score: ctx.strategy.total_score,
            next_objective: ctx.strategy.next_objective,
          }
        : null,
      important_events: ctx.events,
      recent_messages: recent,
      approved_credibility_assets: ctx.credibility.map((c) => ({
        type: c.asset_type,
        name: c.name,
        approved_claim: c.approved_claim,
      })),
      credibility_note:
        ctx.credibility.length === 0
          ? "No approved credibility asset is relevant to this prospect. Cite nothing — never invent a client, outlet, metric or result."
          : "Use only these claims, exactly as written. Never invent or embellish.",
      similar_strong_winners: ctx.examples.strong_winners.map(summariseChunk),
      similar_partial_wins: ctx.examples.partial_wins.map(summariseChunk),
      similar_failures: ctx.examples.failures.map(summariseChunk),
      failures_note: "These are examples of what NOT to repeat. Do not imitate their approach.",
      voice_examples: ctx.examples.voice_examples.map((c) => ({ setter: c.setter_name, content: c.content })),
      voice_note: "Match the phrasing, length and tone of the voice examples. Learn strategy from the winners, not their wording.",
      prospect_new_message: ctx.newMessage || null,
    },
    null,
    2,
  );
}

export async function loadLeadContextByHandle(store: Store, handle: string, newMessage: string): Promise<LeadContext> {
  const lead = await store.getLeadByHandle(handle);
  if (!lead) throw new Error(`Lead not found: ${handle}`);
  return loadLeadContext(store, lead.id, newMessage);
}
