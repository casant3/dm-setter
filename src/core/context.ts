import {
  assessBooking,
  assessNoShowRisk,
  detectStatedTimezone,
  proposeSlots,
  type BookingAssessment,
  type NoShowAssessment,
  type SlotProposal,
} from "@/core/booking";
import { classifyBrushOff, clarificationAlreadyUsed, type BrushOffAssessment } from "@/core/brush-off";
import { buildCoachingLayer, type CoachingLayer } from "@/core/coaching";
import { rankCredibility } from "@/core/credibility";
import { buildDialogueState, summariseDialogueState, type DialogueState } from "@/core/dialogue-state";
import type { MessagePlan } from "@/core/message-plan";
import { assessMotivation, FRAME_GUIDANCE, type MotivationAssessment } from "@/core/motivation";
import { assessQualificationEvidence, type QualificationEvidence } from "@/core/qualification-evidence";
import { assessTemperature, type TemperatureAssessment } from "@/core/temperature";
import { narrativeItem, recomputeUnderstanding } from "@/core/memory";
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
  /** The whole thread, used for the deterministic assessments below. */
  allMessages: Message[];
  /** What has already been asked and answered, semantically. */
  dialogue: DialogueState;
  /** What they are actually motivated by, and how not to frame it. */
  motivation: MotivationAssessment;
  /** How engaged they are right now. */
  temperature: TemperatureAssessment;
  /** Their latest decline, if the latest message is one. */
  brushOff: BrushOffAssessment;
  /** Whether the one post-brush-off clarification has been used. */
  clarificationSpent: boolean;
  /** Evidence behind each qualification dimension. */
  evidence: QualificationEvidence;
  /** How far into booking this conversation actually is. */
  booking: BookingAssessment;
  /** Advisory risk that a call booked now is not honoured. Never a gate. */
  noShow: NoShowAssessment;
  /** Two concrete times to offer, and how to talk about timezone. */
  slotProposal: SlotProposal;
  events: ConversationEvent[];
  credibility: CredibilityAsset[];
  examples: RetrievedExamples;
  understanding: UnderstandingAssessment;
  newMessage: string;
  /** Populated once the strategy pass has run. */
  strategy?: Strategy;
  /** Populated once the gate has been evaluated. */
  plan?: MessagePlan;
  /** How the operator wants this written. Loaded in the enrichment pass. */
  coaching?: CoachingLayer;
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

  // The incoming message is not persisted yet, so it is appended here — every
  // deterministic assessment must see what they just said.
  const pending: Message | null = newMessage.trim()
    ? ({ id: "pending", lead_id: lead.id, sender: "prospect", message_text: newMessage, sent_at: new Date().toISOString() } as Message)
    : null;
  const withPending = pending ? [...allMessages, pending] : allMessages;
  const allProspectMessages = withPending.filter((m) => m.sender === "prospect");

  const understanding = recomputeUnderstanding(memory, allProspectMessages);
  const dialogue = buildDialogueState(withPending, memory);
  const latest = allProspectMessages[allProspectMessages.length - 1] ?? null;
  const brushOff = classifyBrushOff(latest, {
    understandsService: understanding.level >= 2,
    serviceExplained: Boolean(memory?.service_explained),
  });

  const evidence = assessQualificationEvidence({ lead, memory, messages: withPending, dialogue, understanding });
  // Booking state is read before the gate runs, because it depends only on what
  // has already been said — the gate decides whether a call may be raised at
  // all, not how far an existing booking has got.
  const booking = assessBooking(withPending, false);

  return {
    lead,
    memory,
    recentMessages: [...recent].reverse(),
    allProspectMessages,
    allMessages: withPending,
    dialogue,
    motivation: assessMotivation(allProspectMessages, memory),
    temperature: assessTemperature(withPending, dialogue),
    brushOff,
    clarificationSpent: clarificationAlreadyUsed(withPending, brushOff.message_id),
    evidence,
    booking,
    noShow: assessNoShowRisk({
      messages: withPending,
      qualification: {
        fit: evidence.fit.evidenced,
        commercial_goal: evidence.commercial_goal.evidenced,
        media_gap: evidence.media_gap.evidenced,
        value_established: evidence.value_established.evidenced,
        service_understanding: understanding.level,
        interest_signal: evidence.interest_signal.evidenced,
      },
      dialogue,
      booking,
    }),
    slotProposal: proposeSlots({ timezone: lead.timezone ?? detectStatedTimezone(withPending) }),
    events,
    credibility: [],
    examples: { strong_winners: [], partial_wins: [], failures: [], voice_examples: [] },
    understanding,
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

  const [candidates, allCredibility, preferences, coachingExamples, liveMessages] = await Promise.all([
    store.matchChunks(queryText, RETRIEVAL_CANDIDATES),
    store.listCredibility(60),
    store.listSetterPreferences("active"),
    store.listCoachingExamples("approved"),
    store.listApprovedLiveMessages(8),
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
    coaching: buildCoachingLayer({
      preferences,
      examples: coachingExamples,
      liveMessages,
      stage: strategy.stage,
      // Coaching is ranked against what this message is actually doing. Advice
      // about building value before a call is wrong in the message that books
      // one, and dumping everything in buries whatever was relevant.
      situation: {
        move: ctx.plan?.move ?? null,
        stage: strategy.stage,
        temperature: ctx.temperature.temperature,
        brush_off: ctx.brushOff.kind,
        motivation: ctx.motivation.primary,
        avoid_money_framing: ctx.motivation.avoid_money_framing,
        booking_state: ctx.booking.state,
        service_confusion: ctx.understanding.confusion !== null,
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Context serialisation
// ---------------------------------------------------------------------------

function itemValues(items: MemoryItem[] | undefined, limit = 12): string[] {
  return (items ?? []).slice(-limit).map((i) => {
    if (i.provenance === "inference") return `${i.value} (inferred)`;
    if (i.provenance === "research") return `${i.value} (researched — they have not told us this)`;
    return i.value;
  });
}

/**
 * Renders a narrative field as what it is.
 *
 * "Prospect trusts Cassey" is the model's reading of a conversation, and handing
 * it back as a bare string invites the next pass to treat it as something the
 * prospect said. It goes in labelled, with its provenance, unless a person has
 * confirmed it.
 */
function narrativeFor(value: unknown) {
  const item = narrativeItem(value);
  if (!item) return null;
  return {
    value: item.value,
    provenance: item.provenance,
    confidence: item.confidence,
    verified: Boolean(item.verified),
    supported_by: item.quote ?? null,
    source_message_id: item.source_message_id ?? null,
    note: item.verified
      ? "Confirmed by Cassey. Treat it as accurate."
      : "This is an interpretation, not something they said. Do not repeat it back to them as fact, and do not use it as qualification evidence.",
  };
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
            relationship_summary: narrativeFor(m.relationship_summary),
            businesses: itemValues(m.businesses),
            commercial_goals: itemValues(m.goals),
            personal_goals: itemValues(m.personal_goals),
            facts_known: itemValues(m.facts_known),
            researched_verified: (m.research_facts ?? [])
              .filter((f) => f.verified)
              .map((f) => ({ fact: f.value, source: f.source_ref ?? f.quote ?? null, confidence: f.confidence })),
            // Unverified research is deliberately NOT sent. A model cannot leak
            // what it has never seen, and the rule "do not mention this" is a
            // weaker guarantee than not providing it.
            unverified_research_withheld: (m.research_facts ?? []).filter((f) => !f.verified).length,
            research_note:
              (m.research_facts?.length ?? 0) > 0
                ? "We found these ourselves; they have never told us any of it. Only verified facts are given to you, and only as something you may mention noticing publicly — never as something they told you, never more than one, and never in a way that sounds like you researched them. Unverified research is withheld from you on purpose. No research fact ever counts as qualification evidence."
                : null,
            pain_points: itemValues(m.pain_points),
            interests: itemValues(m.interests),
            media_history: itemValues(m.media_history),
            opportunities_identified: itemValues(m.opportunities_identified),
            key_entities: itemValues(m.key_entities),
            timing_constraints: itemValues(m.timing_constraints),
            followup_commitments: itemValues(m.followup_commitments),
            communication_style: narrativeFor(m.communication_style),
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
      conversation_state: {
        ...summariseDialogueState(ctx.dialogue),
        note: "This ledger is computed from the messages themselves. Treat it as fact. Never ask again about anything listed as already answered, however differently you would word it.",
      },
      motivation: {
        primary_frame: ctx.motivation.primary,
        all_frames: ctx.motivation.frames.map((f) => ({ frame: f.frame, their_words: f.quote })),
        talk_about: ctx.motivation.guidance,
        avoid: ctx.motivation.primary ? FRAME_GUIDANCE[ctx.motivation.primary].avoid : null,
        avoid_money_framing: ctx.motivation.avoid_money_framing,
        note: ctx.motivation.primary
          ? "Frame value in these terms. A commercial goal is whatever they are working toward — it is not always money."
          : "No motivation evidenced yet. Ask rather than assume what they care about.",
      },
      engagement: {
        temperature: ctx.temperature.temperature,
        signals: ctx.temperature.signals,
        guidance: ctx.temperature.guidance,
      },
      latest_message_reading:
        ctx.brushOff.kind === "none"
          ? null
          : {
              kind: ctx.brushOff.kind,
              their_words: ctx.brushOff.quote,
              meaning: ctx.brushOff.reason,
              clarification_already_used: ctx.clarificationSpent,
              must_stop: ctx.brushOff.should_disengage,
            },
      qualification_evidence: Object.values(ctx.evidence).map((d) => ({
        dimension: d.dimension,
        evidence_supports: d.evidenced,
        why: d.reason,
        quotes: d.quotes,
      })),
      booking_state: {
        state: ctx.booking.state,
        next_action: ctx.booking.next_action,
        evidence: ctx.booking.evidence,
        note: "Booking is a sequence. Get only the one thing this state needs. Never re-propose a call that has already been agreed.",
      },
      no_show_risk: {
        risk: ctx.noShow.risk,
        factors: ctx.noShow.factors,
        adapt_the_booking: ctx.noShow.guidance,
        mitigation: ctx.noShow.mitigation,
        note: "Advisory only. Qualification decides whether a call may be offered; this decides how it is offered — how explicitly the purpose is framed, which times to pick, how much commitment to ask for. Never withhold a call from a qualified prospect because of this risk.",
      },
      qualification_evidence_note:
        "Score each dimension from this evidence. If you score above what the evidence supports, you must supply the exact quote that justifies it in `evidence`; unverifiable quotes are discarded and the score is capped.",
      message_plan: ctx.plan
        ? {
            move: ctx.plan.move,
            purpose: ctx.plan.purpose,
            desired_response: ctx.plan.desired_response,
            next_if_positive: ctx.plan.next_if_positive,
            next_if_negative: ctx.plan.next_if_negative,
            next_if_no_reply: ctx.plan.next_if_no_reply,
            forbidden_moves: ctx.plan.forbidden,
            ask_about: ctx.plan.ask_topic,
            offer_these_times: ctx.plan.slots.map((s) => s.label),
            timezone: ctx.plan.timezone_note,
            adapt_for_risk: ctx.plan.risk_adaptation,
            slots_note:
              ctx.plan.slots.length > 0
                ? "Propose the call and these two times in the SAME message. That is one move, not two. Do not ask what day suits — offering the times is what removes the extra turn. Adapt the wording naturally; do not read them out as a list."
                : null,
            note: "Make exactly this move. One move per message.",
          }
        : null,
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
      how_cassey_wants_this_written: ctx.coaching
        ? {
            rules_from_cassey: ctx.coaching.rules,
            coaching_for_this_situation: ctx.coaching.examples,
            selected_from: ctx.coaching.considered,
            messages_cassey_actually_sent: ctx.coaching.live_messages,
            precedence: ctx.coaching.precedence,
            note: ctx.coaching.note,
            examples_note:
              "These were chosen because they match this situation — the move, the temperature, the state of the conversation. Where an example carries `avoid` and `because`, that draft was rejected for that reason: do not reproduce it.",
          }
        : null,
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
