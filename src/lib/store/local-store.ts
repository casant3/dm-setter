import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { emptyMemory } from "@/core/memory";
import type {
  AiSuggestion,
  CoachingExample,
  ConversationChunk,
  ConversationEvent,
  CredibilityAsset,
  Lead,
  LeadListItem,
  LeadMemory,
  Message,
  NewLeadInput,
  NewMessageInput,
  NewOutboundAccount,
  OutboundAccount,
  SetterPreference,
  SourceConversation,
} from "@/lib/types";
import { isLegacyAccount, normaliseHandle } from "@/core/accounts";
import { LEGACY_ACCOUNT_HANDLE, LEGACY_ACCOUNT_NAME } from "@/lib/types";
import type { FeedbackInput, FeedbackStats, Store, SuggestionDraft } from "@/lib/store/store";
import { seedData } from "@/lib/store/seed";

type Db = {
  leads: Lead[];
  messages: Message[];
  memories: LeadMemory[];
  events: (ConversationEvent & { lead_id: string })[];
  credibility: CredibilityAsset[];
  chunks: ConversationChunk[];
  suggestions: AiSuggestion[];
  source_conversations: SourceConversation[];
  setter_preferences: SetterPreference[];
  coaching_examples: CoachingExample[];
  outbound_accounts: OutboundAccount[];
};

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "was",
  "were", "be", "been", "it", "this", "that", "i", "you", "we", "they", "my", "your", "our",
  "at", "as", "by", "from", "so", "if", "but", "not", "do", "does", "did", "have", "has",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * File-backed development store.
 *
 * This is NOT a replacement for Supabase — it exists so the UI, the pipeline and
 * the tests can run end to end without credentials. Retrieval here approximates
 * pgvector with token overlap.
 */
export class LocalStore implements Store {
  readonly mode = "local" as const;
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir = process.env.LOCAL_STORE_DIR || ".data") {
    this.file = path.resolve(process.cwd(), dataDir, "store.json");
  }

  private async read(): Promise<Db> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<Db>;
      return {
        leads: raw.leads ?? [],
        messages: raw.messages ?? [],
        memories: raw.memories ?? [],
        events: raw.events ?? [],
        credibility: raw.credibility ?? [],
        chunks: raw.chunks ?? [],
        suggestions: raw.suggestions ?? [],
        source_conversations: raw.source_conversations ?? [],
        setter_preferences: raw.setter_preferences ?? [],
        coaching_examples: raw.coaching_examples ?? [],
        outbound_accounts: raw.outbound_accounts ?? [],
      };
    } catch {
      const fresh = seedData();
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(fresh, null, 2));
      return fresh;
    }
  }

  /** Serializes read-modify-write cycles so concurrent requests cannot clobber each other. */
  private transact<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const db = await this.read();
      const result = await fn(db);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(db, null, 2));
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  // -------------------------------------------------------------------------
  // Outbound accounts
  // -------------------------------------------------------------------------

  async listOutboundAccounts(options: { includeInactive?: boolean } = {}): Promise<OutboundAccount[]> {
    const db = await this.read();
    const rows = db.outbound_accounts ?? [];
    return (options.includeInactive ? rows : rows.filter((a) => a.active)).sort((a, b) =>
      a.handle.localeCompare(b.handle),
    );
  }

  async getOutboundAccount(id: string): Promise<OutboundAccount | null> {
    const db = await this.read();
    return (db.outbound_accounts ?? []).find((a) => a.id === id) ?? null;
  }

  async createOutboundAccount(input: NewOutboundAccount): Promise<OutboundAccount> {
    const handle = normaliseHandle(input.handle);
    if (!handle) throw new Error("An account handle is required");
    return this.transact((db) => {
      db.outbound_accounts = db.outbound_accounts ?? [];
      const platform = input.platform?.trim() || "instagram";
      const existing = db.outbound_accounts.find(
        (a) => a.platform === platform && normaliseHandle(a.handle) === handle,
      );
      if (existing) throw new Error(`@${handle} is already an outbound account`);
      const account: OutboundAccount = {
        id: randomUUID(),
        platform,
        handle,
        display_name: input.display_name?.trim() || null,
        active: input.active ?? true,
        notes: input.notes?.trim() || null,
        created_at: new Date().toISOString(),
      };
      db.outbound_accounts.push(account);
      return account;
    });
  }

  async updateOutboundAccount(id: string, patch: Partial<OutboundAccount>): Promise<OutboundAccount> {
    return this.transact((db) => {
      const account = (db.outbound_accounts ?? []).find((a) => a.id === id);
      if (!account) throw new Error(`Outbound account not found: ${id}`);
      Object.assign(account, patch, { id, created_at: account.created_at });
      if (patch.handle) account.handle = normaliseHandle(patch.handle);
      return account;
    });
  }

  async legacyOutboundAccount(): Promise<OutboundAccount> {
    const existing = (await this.listOutboundAccounts({ includeInactive: true })).find((a) =>
      isLegacyAccount(a),
    );
    if (existing) return existing;
    return this.createOutboundAccount({
      platform: "unknown",
      handle: LEGACY_ACCOUNT_HANDLE,
      display_name: LEGACY_ACCOUNT_NAME,
      // Inactive on purpose: nothing new is ever sent from "we do not know".
      active: false,
      notes: "Conversations from before outbound accounts were tracked. Never guess which page sent them.",
    });
  }

  async listLeads(options: { accountId?: string | null } = {}): Promise<LeadListItem[]> {
    const db = await this.read();
    const accounts = new Map((db.outbound_accounts ?? []).map((a) => [a.id, a]));
    const scoped =
      options.accountId === undefined
        ? db.leads
        : db.leads.filter((l) => (l.outbound_account_id ?? null) === (options.accountId ?? null));
    const items = scoped.map((lead) => {
      const account = lead.outbound_account_id ? accounts.get(lead.outbound_account_id) ?? null : null;
      const msgs = db.messages
        .filter((m) => m.lead_id === lead.id)
        .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
      const last = msgs[msgs.length - 1];
      return {
        ...lead,
        outbound_account_handle: account?.handle ?? null,
        outbound_account_name: account?.display_name ?? null,
        message_count: msgs.length,
        last_message_at: last?.sent_at ?? null,
        last_message_preview: last ? last.message_text.slice(0, 140) : null,
        last_message_sender: last?.sender ?? null,
        awaiting_reply: last?.sender === "prospect",
      };
    });
    return items.sort((a, b) => {
      const at = a.last_message_at ?? a.created_at ?? "";
      const bt = b.last_message_at ?? b.created_at ?? "";
      return bt.localeCompare(at);
    });
  }

  async getLead(id: string): Promise<Lead | null> {
    const db = await this.read();
    return db.leads.find((l) => l.id === id) ?? null;
  }

  async getLeadByHandle(handle: string, options: { accountId?: string | null } = {}): Promise<Lead | null> {
    const matches = await this.findLeadsByHandle(handle);
    if (options.accountId !== undefined) {
      return matches.find((l) => (l.outbound_account_id ?? null) === (options.accountId ?? null)) ?? null;
    }
    // No account given: the most recently active thread is the one meant.
    return (
      [...matches].sort((a, b) =>
        (b.last_contact_at ?? b.created_at ?? "").localeCompare(a.last_contact_at ?? a.created_at ?? ""),
      )[0] ?? null
    );
  }

  async findLeadsByHandle(handle: string): Promise<Lead[]> {
    const db = await this.read();
    const wanted = normaliseHandle(handle);
    return db.leads.filter((l) => normaliseHandle(l.instagram_handle) === wanted);
  }

  async createLead(input: NewLeadInput): Promise<Lead> {
    return this.transact((db) => {
      const now = new Date().toISOString();
      const lead: Lead = {
        id: randomUUID(),
        instagram_handle: input.instagram_handle,
        outbound_account_id: input.outbound_account_id ?? null,
        name: input.name ?? null,
        company: input.company ?? null,
        job_title: input.job_title ?? null,
        industry: input.industry ?? null,
        niche: input.niche ?? null,
        followers: input.followers ?? null,
        location: input.location ?? null,
        lead_status: "active",
        interest_level: null,
        conversation_stage: input.conversation_stage ?? "NEW_LEAD",
        priority: input.priority ?? "medium",
        media_experience: null,
        authority_level: null,
        media_gap: input.media_gap ?? null,
        commercial_goal: input.commercial_goal ?? null,
        first_contact_at: null,
        last_contact_at: null,
        next_followup_at: null,
        followup_status: input.followup_status ?? "none",
        followup_note: null,
        booked_call: false,
        booked_call_at: null,
        outcome: null,
        created_at: now,
        updated_at: now,
      };
      db.leads.push(lead);
      return lead;
    });
  }

  async updateLead(id: string, patch: Partial<Lead>): Promise<Lead> {
    return this.transact((db) => {
      const lead = db.leads.find((l) => l.id === id);
      if (!lead) throw new Error(`Lead not found: ${id}`);
      Object.assign(lead, patch, { updated_at: new Date().toISOString() });
      return lead;
    });
  }

  async listMessages(leadId: string): Promise<Message[]> {
    const db = await this.read();
    return db.messages
      .filter((m) => m.lead_id === leadId)
      .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  }

  async recentMessages(leadId: string, limit: number): Promise<Message[]> {
    const all = await this.listMessages(leadId);
    return all.slice(-limit).reverse();
  }

  async appendMessages(leadId: string, messages: NewMessageInput[]): Promise<Message[]> {
    if (messages.length === 0) return [];
    return this.transact((db) => {
      const created = messages.map((m) => {
        const row: Message = {
          id: randomUUID(),
          lead_id: leadId,
          sender: m.sender,
          message_text: m.message_text,
          message_type: "text",
          sent_at: m.sent_at ?? new Date().toISOString(),
          channel: "instagram",
          is_question: m.message_text.includes("?"),
          is_cta: null,
          is_objection: null,
          is_buying_signal: null,
          sent_by_ai: m.sent_by_ai ?? false,
          ai_suggestion_id: m.ai_suggestion_id ?? null,
        };
        db.messages.push(row);
        return row;
      });
      const lead = db.leads.find((l) => l.id === leadId);
      if (lead) {
        const latest = created.reduce((a, b) => (a.sent_at > b.sent_at ? a : b));
        lead.last_contact_at = latest.sent_at;
        if (!lead.first_contact_at) lead.first_contact_at = created[0].sent_at;
        lead.updated_at = new Date().toISOString();
      }
      return created;
    });
  }

  async getMemory(leadId: string): Promise<LeadMemory | null> {
    const db = await this.read();
    return db.memories.find((m) => m.lead_id === leadId) ?? null;
  }

  async upsertMemory(leadId: string, patch: Partial<LeadMemory>): Promise<LeadMemory> {
    return this.transact((db) => {
      const existing = db.memories.find((m) => m.lead_id === leadId);
      if (existing) {
        Object.assign(existing, patch, { lead_id: leadId });
        return existing;
      }
      const created: LeadMemory = { ...emptyMemory(leadId), ...patch, lead_id: leadId };
      db.memories.push(created);
      return created;
    });
  }

  async listEvents(leadId: string, limit: number): Promise<ConversationEvent[]> {
    const db = await this.read();
    return db.events
      .filter((e) => e.lead_id === leadId)
      .sort((a, b) => b.happened_at.localeCompare(a.happened_at))
      .slice(0, limit)
      .map(({ event_type, description, importance, happened_at }) => ({
        event_type,
        description,
        importance,
        happened_at,
      }));
  }

  async addEvent(leadId: string, event: Omit<ConversationEvent, "id">): Promise<void> {
    await this.transact((db) => {
      db.events.push({ ...event, lead_id: leadId });
    });
  }

  async listCredibility(limit: number): Promise<CredibilityAsset[]> {
    const db = await this.read();
    return db.credibility.slice(0, limit);
  }

  async listSuggestions(leadId: string): Promise<AiSuggestion[]> {
    const db = await this.read();
    return db.suggestions
      .filter((s) => s.lead_id === leadId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getSuggestion(id: string): Promise<AiSuggestion | null> {
    const db = await this.read();
    return db.suggestions.find((s) => s.id === id) ?? null;
  }

  async createSuggestion(draft: SuggestionDraft): Promise<AiSuggestion> {
    return this.transact((db) => {
      const row: AiSuggestion = {
        id: randomUUID(),
        lead_id: draft.lead_id,
        suggested_message: draft.suggested_message,
        strategy: draft.strategy,
        context_used: draft.context_used,
        examples_used: draft.examples_used,
        accepted: null,
        edited: null,
        rejected: null,
        feedback: null,
        feedback_at: null,
        feedback_note: null,
        final_message_sent: null,
        prospect_replied: null,
        reply_sentiment: null,
        eventual_booking: null,
        created_at: new Date().toISOString(),
      };
      db.suggestions.push(row);
      return row;
    });
  }

  async recordFeedback(suggestionId: string, input: FeedbackInput): Promise<AiSuggestion> {
    return this.transact((db) => {
      const row = db.suggestions.find((s) => s.id === suggestionId);
      if (!row) throw new Error(`Suggestion not found: ${suggestionId}`);
      row.feedback = input.feedback;
      row.feedback_at = new Date().toISOString();
      row.feedback_note = input.note ?? null;
      row.accepted = input.feedback !== "rejected";
      row.edited = input.feedback === "edited";
      row.rejected = input.feedback === "rejected";
      row.final_message_sent = input.final_message_sent ?? null;
      return row;
    });
  }

  async feedbackStats(): Promise<FeedbackStats> {
    const db = await this.read();
    const withFeedback = db.suggestions.filter((s) => s.feedback);

    const byFeedback = new Map<string, { count: number; total: number }>();
    const byStage = new Map<string, { used: number; edited: number; rejected: number }>();

    for (const s of withFeedback) {
      const f = s.feedback!;
      const fb = byFeedback.get(f) ?? { count: 0, total: 0 };
      fb.count += 1;
      fb.total += s.strategy?.total_score ?? 0;
      byFeedback.set(f, fb);

      const stage = s.strategy?.stage ?? "UNKNOWN";
      const st = byStage.get(stage) ?? { used: 0, edited: 0, rejected: 0 };
      st[f] += 1;
      byStage.set(stage, st);
    }

    return {
      by_feedback: [...byFeedback].map(([feedback, v]) => ({
        feedback,
        count: v.count,
        avg_score: v.count ? Number((v.total / v.count).toFixed(2)) : null,
      })),
      by_stage: [...byStage].map(([stage, v]) => ({ stage, ...v })),
      recent_edits: withFeedback
        .filter((s) => s.feedback === "edited" && s.final_message_sent)
        .sort((a, b) => (b.feedback_at ?? "").localeCompare(a.feedback_at ?? ""))
        .slice(0, 25)
        .map((s) => ({
          suggested: s.suggested_message,
          sent: s.final_message_sent!,
          stage: s.strategy?.stage ?? "UNKNOWN",
          at: s.feedback_at ?? s.created_at,
        })),
    };
  }

  async matchChunks(queryText: string, limit: number): Promise<ConversationChunk[]> {
    const db = await this.read();
    const query = new Set(tokenize(queryText));
    if (query.size === 0) return [];
    return db.chunks
      .map((c) => {
        const tokens = new Set(tokenize(`${c.content} ${c.niche ?? ""} ${c.industry ?? ""} ${c.stage ?? ""}`));
        let overlap = 0;
        for (const t of query) if (tokens.has(t)) overlap += 1;
        const union = new Set([...query, ...tokens]).size;
        return { ...c, similarity: union === 0 ? 0 : overlap / union };
      })
      .filter((c) => (c.similarity ?? 0) > 0)
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, limit);
  }

  async listSourceConversations(status?: string): Promise<SourceConversation[]> {
    const db = await this.read();
    const rows = status ? db.source_conversations.filter((s) => s.status === status) : db.source_conversations;
    return [...rows].sort((a, b) => (a.instagram_handle ?? "").localeCompare(b.instagram_handle ?? ""));
  }

  async getSourceConversation(id: string): Promise<SourceConversation | null> {
    const db = await this.read();
    return db.source_conversations.find((s) => s.id === id) ?? null;
  }

  async upsertSourceConversation(
    row: Partial<SourceConversation> & { external_card_id: string },
  ): Promise<SourceConversation> {
    return this.transact((db) => {
      const existing = db.source_conversations.find((s) => s.external_card_id === row.external_card_id);
      if (existing) {
        // Never clobber a human-verified transcript with a re-ingest.
        const protectedFields = existing.status === "verified" ? { transcript: existing.transcript, labels: existing.labels, status: existing.status } : {};
        Object.assign(existing, row, protectedFields);
        return existing;
      }
      const created: SourceConversation = {
        id: randomUUID(),
        source: "trello",
        instagram_handle: null,
        setter_name: null,
        outcome: null,
        outcome_tier: null,
        stage: null,
        transcript: null,
        notes: null,
        screenshot_paths: [],
        quality_score: null,
        status: "pending_ocr",
        outcome_history: [],
        labels: null,
        verified_by: null,
        verified_at: null,
        created_at: new Date().toISOString(),
        ...row,
      };
      db.source_conversations.push(created);
      return created;
    });
  }

  async updateSourceConversation(id: string, patch: Partial<SourceConversation>): Promise<SourceConversation> {
    return this.transact((db) => {
      const row = db.source_conversations.find((s) => s.id === id);
      if (!row) throw new Error(`Source conversation not found: ${id}`);
      Object.assign(row, patch, { id });
      return row;
    });
  }

  // --- coaching ------------------------------------------------------------

  async listSetterPreferences(status?: string): Promise<SetterPreference[]> {
    const db = await this.read();
    const rows = status ? db.setter_preferences.filter((p) => p.status === status) : db.setter_preferences;
    return [...rows].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  async createSetterPreference(input: Omit<SetterPreference, "id" | "created_at">): Promise<SetterPreference> {
    return this.transact((db) => {
      const created: SetterPreference = { ...input, id: randomUUID(), created_at: new Date().toISOString() };
      db.setter_preferences.push(created);
      return created;
    });
  }

  async updateSetterPreference(id: string, patch: Partial<SetterPreference>): Promise<SetterPreference> {
    return this.transact((db) => {
      const row = db.setter_preferences.find((p) => p.id === id);
      if (!row) throw new Error(`Setter preference not found: ${id}`);
      Object.assign(row, patch, { id });
      return row;
    });
  }

  async listCoachingExamples(status?: string): Promise<CoachingExample[]> {
    const db = await this.read();
    const rows = status ? db.coaching_examples.filter((e) => e.status === status) : db.coaching_examples;
    return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async createCoachingExample(input: Omit<CoachingExample, "id" | "created_at">): Promise<CoachingExample> {
    return this.transact((db) => {
      const created: CoachingExample = { ...input, id: randomUUID(), created_at: new Date().toISOString() };
      db.coaching_examples.push(created);
      return created;
    });
  }

  async updateCoachingExample(id: string, patch: Partial<CoachingExample>): Promise<CoachingExample> {
    return this.transact((db) => {
      const row = db.coaching_examples.find((e) => e.id === id);
      if (!row) throw new Error(`Coaching example not found: ${id}`);
      Object.assign(row, patch, { id });
      return row;
    });
  }

  async listApprovedLiveMessages(limit: number) {
    const db = await this.read();
    return db.suggestions
      .filter((s) => (s.feedback === "used" || s.feedback === "edited") && s.final_message_sent)
      .sort((a, b) => (b.feedback_at ?? b.created_at).localeCompare(a.feedback_at ?? a.created_at))
      .slice(0, limit)
      .map((s) => ({
        sent: s.final_message_sent!,
        stage: s.strategy?.stage ?? null,
        at: s.feedback_at ?? s.created_at,
        edited: s.feedback === "edited",
      }));
  }

  async replaceChunksForConversation(
    conversationId: string,
    chunks: Omit<ConversationChunk, "id" | "similarity">[],
  ): Promise<number> {
    return this.transact((db) => {
      db.chunks = db.chunks.filter((c) => c.source_conversation_id !== conversationId);
      for (const c of chunks) {
        db.chunks.push({ ...c, id: randomUUID(), similarity: null, source_conversation_id: conversationId });
      }
      return chunks.length;
    });
  }
}
