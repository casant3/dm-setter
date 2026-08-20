/**
 * Domain types shared by the agent core, the store adapters and the web UI.
 * These mirror `supabase/schema.sql` plus the additive migrations.
 */

export type Sender = "setter" | "prospect" | "system";

/** Canonical follow-up states used by the sidebar filters and the follow-up control. */
export const FOLLOWUP_STATUSES = [
  "none",
  "waiting_on_them",
  "owed_reply",
  "scheduled",
  "overdue",
  "closed",
] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SUGGESTION_FEEDBACK = ["used", "edited", "rejected"] as const;
export type SuggestionFeedback = (typeof SUGGESTION_FEEDBACK)[number];

// ---------------------------------------------------------------------------
// Historical outcome tiers
// ---------------------------------------------------------------------------

/**
 * Downstream quality of a past conversation.
 *
 * A booked call is not evidence of a good conversation: some Discovery bookings
 * in the real corpus later became No Show or Not Interested because the prospect
 * had not understood the offer. Tiers rank by what actually happened next.
 */
export const OUTCOME_TIERS = ["A", "B", "C", "D", "E", "F"] as const;
export type OutcomeTier = (typeof OUTCOME_TIERS)[number];

export const TIER_DESCRIPTIONS: Record<OutcomeTier, string> = {
  A: "Onboarded / closed / converted",
  B: "Qualified discovery that showed or progressed",
  C: "Discovery booked, downstream outcome unknown",
  D: "Nurture / future follow-up / info packet",
  E: "No show",
  F: "Not interested",
};

/** How a retrieved example is presented to the writer. */
export type EvidenceClass = "strong_winner" | "partial_win" | "failure" | "neutral";

export const TIER_EVIDENCE: Record<OutcomeTier, EvidenceClass> = {
  A: "strong_winner",
  B: "partial_win",
  C: "neutral",
  D: "neutral",
  E: "failure",
  F: "failure",
};

// ---------------------------------------------------------------------------
// Leads and messages
// ---------------------------------------------------------------------------

export type Lead = {
  id: string;
  instagram_handle: string;
  name: string | null;
  company: string | null;
  job_title: string | null;
  industry: string | null;
  niche: string | null;
  followers: number | null;
  location: string | null;
  lead_status: string | null;
  interest_level: string | null;
  conversation_stage: string | null;
  priority: Priority | null;
  media_experience: string | null;
  authority_level: string | null;
  media_gap: string | null;
  commercial_goal: string | null;
  first_contact_at: string | null;
  last_contact_at: string | null;
  next_followup_at: string | null;
  followup_status: FollowupStatus | null;
  followup_note: string | null;
  booked_call: boolean | null;
  booked_call_at: string | null;
  outcome: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type Message = {
  id: string;
  lead_id: string;
  sender: Sender;
  message_text: string;
  message_type: string | null;
  sent_at: string;
  channel: string | null;
  is_question: boolean | null;
  is_cta: boolean | null;
  is_objection: boolean | null;
  is_buying_signal: boolean | null;
  sent_by_ai: boolean | null;
  ai_suggestion_id: string | null;
};

// ---------------------------------------------------------------------------
// Long-term memory
// ---------------------------------------------------------------------------

/** Where a remembered item came from, so it can be traced back and trusted. */
export type Provenance = "fact" | "inference" | "human";

/**
 * One remembered item. Facts are quoted from the prospect; inferences are the
 * model's reading; human entries are corrections a person made and must not be
 * silently overwritten.
 */
export type MemoryItem = {
  value: string;
  provenance: Provenance;
  /** 0–1. Human corrections are always 1. */
  confidence: number;
  /** The message this came from, when it came from one. */
  source_message_id?: string | null;
  /** Verbatim supporting quote, when available. */
  quote?: string | null;
  recorded_at: string;
  /** True once a human has confirmed or written this item. */
  verified?: boolean;
};

export type LeadMemory = {
  lead_id: string;
  relationship_summary: string | null;
  facts_known: MemoryItem[];
  businesses: MemoryItem[];
  goals: MemoryItem[];
  personal_goals: MemoryItem[];
  pain_points: MemoryItem[];
  interests: MemoryItem[];
  objections: MemoryItem[];
  media_history: MemoryItem[];
  opportunities_identified: MemoryItem[];
  questions_already_asked: MemoryItem[];
  offers_explained: MemoryItem[];
  ctas_already_used: MemoryItem[];
  buying_signals: MemoryItem[];
  timing_constraints: MemoryItem[];
  followup_commitments: MemoryItem[];
  key_entities: MemoryItem[];
  communication_style: string | null;
  current_strategy: string | null;

  /** An action we took: we sent an explanation of the business model. */
  service_explained: boolean | null;
  service_explained_at: string | null;
  service_explained_count: number | null;

  /** A state of the prospect, evidenced only by their own messages. */
  service_understanding: number | null;
  service_understanding_evidence: unknown[];

  /** Fields a human has verified; automatic updates must not overwrite these. */
  verified_fields: string[];
  updated_at: string | null;
};

export type ConversationEvent = {
  id?: string;
  event_type: string;
  description: string;
  importance: number | null;
  happened_at: string;
};

export type CredibilityAsset = {
  id?: string;
  asset_type: "client" | "media_outlet" | "case_study";
  name: string;
  approved_claim: string;
  niches: string[] | null;
  industries?: string[] | null;
  /** Set by the ranker, not stored. */
  relevance?: number;
};

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** A retrieved slice of a past conversation, used as winner/failure evidence. */
export type ConversationChunk = {
  id: string;
  source_conversation_id: string | null;
  outcome: string | null;
  outcome_tier: OutcomeTier | null;
  stage: string | null;
  niche: string | null;
  industry: string | null;
  setter_name: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  quality_score: number | null;
  similarity: number | null;
  /** Final rank score after structured reranking. */
  score?: number;
  /** Human-readable reasons this example was selected, shown in the UI. */
  match_reasons?: string[];
  evidence_class?: EvidenceClass;
};

export type RetrievedExamples = {
  strong_winners: ConversationChunk[];
  partial_wins: ConversationChunk[];
  failures: ConversationChunk[];
  /** Examples chosen specifically because they are in Cassey's voice. */
  voice_examples: ConversationChunk[];
};

// ---------------------------------------------------------------------------
// Strategy / pipeline
// ---------------------------------------------------------------------------

export type Qualification = {
  fit: number;
  commercial_goal: number;
  media_gap: number;
  value_established: number;
  service_understanding: number;
  interest_signal: number;
};

/** A score the strategist claims, with the quote it says supports it. */
export type ClaimedDimensionEvidence = {
  dimension: string;
  quote: string;
  message_id?: string | null;
};

export type Strategy = {
  stage: string;
  qualification: Qualification;
  total_score: number;
  call_ready: boolean;
  service_confusion: boolean;
  confusion_reason: string | null;
  next_objective: string;
  strategy: string;
  missing_information: string[];
  credibility_needed: boolean;
  credibility_reason: string | null;
  should_explain_service: boolean;
  /** Quotes the strategist offers for the scores it gave. Verified before use. */
  evidence?: ClaimedDimensionEvidence[];
  /** Scores the evidence would not support, and what they were reduced to. */
  evidence_adjustments?: string[];
};

export type Review = {
  approved: boolean;
  issues: string[];
  final_reply: string;
  /** What this specific message is for, per the reviewer checklist. */
  message_purpose?: string;
  /** The forward path: what we want back, and what we do with each outcome. */
  desired_response?: string;
  next_if_positive?: string;
  next_if_negative?: string;
  next_if_no_reply?: string;
};

export type AiSuggestion = {
  id: string;
  lead_id: string;
  suggested_message: string;
  strategy: Strategy;
  context_used: Record<string, unknown>;
  examples_used: string[];
  accepted: boolean | null;
  edited: boolean | null;
  rejected: boolean | null;
  feedback: SuggestionFeedback | null;
  feedback_at: string | null;
  feedback_note: string | null;
  final_message_sent: string | null;
  prospect_replied: boolean | null;
  reply_sentiment: string | null;
  eventual_booking: boolean | null;
  created_at: string;
};

export type GateResult = {
  passed: boolean;
  blockers: string[];
  missing_dimensions: (keyof Qualification)[];
  total_score: number;
  model_said_call_ready: boolean;
};

/** Everything the copilot panel needs after one generation run. */
export type AgentResult = {
  suggestion_id: string | null;
  strategy: Strategy;
  reply: string;
  reviewer: Review;
  gate: GateResult;
  examples: RetrievedExamples;
  credibility_used: CredibilityAsset[];
  understanding: {
    level: number;
    service_explained: boolean;
    evidence: unknown[];
    confusion_reason: string | null;
    commercial_clarity_needed: string | null;
  };
  /** The one move this message makes, and what happens after they reply. */
  plan: {
    move: string;
    purpose: string;
    desired_response: string;
    next_if_positive: string;
    next_if_negative: string;
    next_if_no_reply: string;
  };
  /** Deterministic checks on the message actually being suggested. */
  audit: {
    ok: boolean;
    violations: { rule: string; detail: string; severity: "hard" | "soft" }[];
    words: number;
  };
  /** How the prospect is engaging, and what they have already told us. */
  read: {
    temperature: string;
    motivation: string | null;
    already_answered: string[];
    brush_off: string | null;
  };
  engine: "openai" | "offline";
  timings: Record<string, number>;
};

export type LeadListItem = Lead & {
  message_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_sender: Sender | null;
  awaiting_reply: boolean;
};

export type NewLeadInput = {
  instagram_handle: string;
  name?: string | null;
  company?: string | null;
  job_title?: string | null;
  industry?: string | null;
  niche?: string | null;
  followers?: number | null;
  location?: string | null;
  commercial_goal?: string | null;
  media_gap?: string | null;
  priority?: Priority | null;
  followup_status?: FollowupStatus | null;
  conversation_stage?: string | null;
};

export type NewMessageInput = {
  sender: Sender;
  message_text: string;
  sent_at?: string;
  sent_by_ai?: boolean;
  ai_suggestion_id?: string | null;
};

// ---------------------------------------------------------------------------
// Historical corpus
// ---------------------------------------------------------------------------

export const TRANSCRIPT_STATUSES = ["pending_ocr", "needs_review", "verified", "rejected"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export type SourceConversation = {
  id: string;
  source: string;
  external_card_id: string | null;
  instagram_handle: string | null;
  setter_name: string | null;
  outcome: string | null;
  outcome_tier: OutcomeTier | null;
  stage: string | null;
  transcript: string | null;
  notes: string | null;
  screenshot_paths: unknown[];
  quality_score: number | null;
  status: TranscriptStatus;
  /** Movement history from the board, the basis of the downstream tier. */
  outcome_history: unknown[];
  labels: Record<string, unknown> | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string | null;
};
