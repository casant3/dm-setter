/**
 * Domain types shared by the agent core, the store adapters and the web UI.
 * These mirror `supabase/schema.sql` plus the additive `002_web_app.sql` migration.
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

export type LeadMemory = {
  lead_id: string;
  relationship_summary: string | null;
  facts_known: unknown[];
  businesses: unknown[];
  goals: unknown[];
  pain_points: unknown[];
  interests: unknown[];
  objections: unknown[];
  media_history: unknown[];
  opportunities_identified: unknown[];
  questions_already_asked: unknown[];
  offers_explained: unknown[];
  ctas_already_used: unknown[];
  communication_style: string | null;
  current_strategy: string | null;
  service_understanding: number | null;
  updated_at: string | null;
};

export type ConversationEvent = {
  event_type: string;
  description: string;
  importance: number | null;
  happened_at: string;
};

export type CredibilityAsset = {
  asset_type: "client" | "media_outlet" | "case_study";
  name: string;
  approved_claim: string;
  niches: string[] | null;
};

/** A retrieved slice of a past conversation, used as winner/failure evidence. */
export type ConversationChunk = {
  id: string;
  source_conversation_id: string | null;
  outcome: string | null;
  stage: string | null;
  niche: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  similarity: number | null;
};

export type Qualification = {
  fit: number;
  commercial_goal: number;
  media_gap: number;
  value_established: number;
  service_understanding: number;
  interest_signal: number;
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
};

export type Review = {
  approved: boolean;
  issues: string[];
  final_reply: string;
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

/** Everything the copilot panel needs after one generation run. */
export type AgentResult = {
  suggestion_id: string | null;
  strategy: Strategy;
  reply: string;
  reviewer: Review;
  gate: GateResult;
  similar_winners: ConversationChunk[];
  similar_failures: ConversationChunk[];
  engine: "openai" | "offline";
};

/** The deterministic hard gate applied on top of the model's own judgement. */
export type GateResult = {
  passed: boolean;
  blockers: string[];
  model_said_call_ready: boolean;
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
