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
  /** Newest first, capped — the working context the agent core reads. */
  recentMessages(leadId: string, limit: number): Promise<Message[]>;
  appendMessages(leadId: string, messages: NewMessageInput[]): Promise<Message[]>;

  getMemory(leadId: string): Promise<LeadMemory | null>;
  /** Merges a patch into permanent lead memory, creating the row if absent. */
  upsertMemory(leadId: string, patch: Partial<LeadMemory>): Promise<LeadMemory>;
  listEvents(leadId: string, limit: number): Promise<ConversationEvent[]>;
  listCredibility(limit: number): Promise<CredibilityAsset[]>;

  listSuggestions(leadId: string): Promise<AiSuggestion[]>;
  createSuggestion(draft: SuggestionDraft): Promise<AiSuggestion>;
  recordFeedback(suggestionId: string, input: FeedbackInput): Promise<AiSuggestion>;

  /**
   * Retrieve past conversation slices similar to `queryText`, restricted to the
   * given outcome labels. Supabase uses pgvector; the local store uses a
   * keyword-overlap approximation.
   */
  matchChunks(queryText: string, outcomes: string[], limit: number): Promise<ConversationChunk[]>;
}
