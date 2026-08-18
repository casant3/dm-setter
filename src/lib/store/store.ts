import type {
  AiSuggestion,
  ConversationChunk,
  ConversationEvent,
  CredibilityAsset,
  Lead,
  LeadListItem,
  LeadMemory,
  Message,
  NewLeadInput,
  NewMessageInput,
  SourceConversation,
  Strategy,
  SuggestionFeedback,
} from "@/lib/types";

export type SuggestionDraft = {
  lead_id: string;
  suggested_message: string;
  strategy: Strategy;
  context_used: Record<string, unknown>;
  examples_used: string[];
};

export type FeedbackInput = {
  feedback: SuggestionFeedback;
  final_message_sent?: string | null;
  note?: string | null;
};

export type FeedbackStats = {
  by_feedback: { feedback: string; count: number; avg_score: number | null }[];
  by_stage: { stage: string; used: number; edited: number; rejected: number }[];
  /** Suggestions whose sent text differed from the suggestion, for voice tuning. */
  recent_edits: { suggested: string; sent: string; stage: string; at: string }[];
};

/**
 * Persistence boundary for the agent core and the web app.
 *
 * Supabase remains the source of truth; `LocalStore` exists only so the app and
 * its tests can run without live credentials.
 */
export interface Store {
  readonly mode: "supabase" | "local";

  listLeads(): Promise<LeadListItem[]>;
  getLead(id: string): Promise<Lead | null>;
  getLeadByHandle(handle: string): Promise<Lead | null>;
  createLead(input: NewLeadInput): Promise<Lead>;
  updateLead(id: string, patch: Partial<Lead>): Promise<Lead>;

  /** Oldest first — the order the conversation view renders. */
  listMessages(leadId: string): Promise<Message[]>;
  /** Newest first, capped — the working context window. */
  recentMessages(leadId: string, limit: number): Promise<Message[]>;
  appendMessages(leadId: string, messages: NewMessageInput[]): Promise<Message[]>;

  getMemory(leadId: string): Promise<LeadMemory | null>;
  /** Merges a patch into permanent lead memory, creating the row if absent. */
  upsertMemory(leadId: string, patch: Partial<LeadMemory>): Promise<LeadMemory>;

  listEvents(leadId: string, limit: number): Promise<ConversationEvent[]>;
  addEvent(leadId: string, event: Omit<ConversationEvent, "id">): Promise<void>;
  listCredibility(limit: number): Promise<CredibilityAsset[]>;

  listSuggestions(leadId: string): Promise<AiSuggestion[]>;
  createSuggestion(draft: SuggestionDraft): Promise<AiSuggestion>;
  recordFeedback(suggestionId: string, input: FeedbackInput): Promise<AiSuggestion>;
  getSuggestion(id: string): Promise<AiSuggestion | null>;
  feedbackStats(): Promise<FeedbackStats>;

  /**
   * Retrieve past conversation slices similar to `queryText`. Outcome filtering
   * is deliberately NOT done here: reranking needs winners and failures in the
   * same candidate pool so it can bucket them.
   */
  matchChunks(queryText: string, limit: number): Promise<ConversationChunk[]>;

  /** Historical corpus, used by the ingestion pipeline and the verification UI. */
  listSourceConversations(status?: string): Promise<SourceConversation[]>;
  getSourceConversation(id: string): Promise<SourceConversation | null>;
  upsertSourceConversation(row: Partial<SourceConversation> & { external_card_id: string }): Promise<SourceConversation>;
  replaceChunksForConversation(conversationId: string, chunks: Omit<ConversationChunk, "id" | "similarity">[]): Promise<number>;
}
