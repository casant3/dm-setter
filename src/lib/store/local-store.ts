import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
} from "@/lib/types";
import type { FeedbackInput, Store, SuggestionDraft } from "@/lib/store/store";
import { seedData } from "@/lib/store/seed";

type Db = {
  leads: Lead[];
  messages: Message[];
  memories: LeadMemory[];
  events: (ConversationEvent & { lead_id: string })[];
  credibility: CredibilityAsset[];
  chunks: (ConversationChunk & { content: string })[];
  suggestions: AiSuggestion[];
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
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Db;
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

  async listLeads(): Promise<LeadListItem[]> {
    const db = await this.read();
    const items = db.leads.map((lead) => {
      const msgs = db.messages
        .filter((m) => m.lead_id === lead.id)
        .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
      const last = msgs[msgs.length - 1];
      return {
        ...lead,
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

  async getLeadByHandle(handle: string): Promise<Lead | null> {
    const db = await this.read();
    return db.leads.find((l) => l.instagram_handle.toLowerCase() === handle.toLowerCase()) ?? null;
  }

  async createLead(input: NewLeadInput): Promise<Lead> {
    return this.transact((db) => {
      const now = new Date().toISOString();
      const lead: Lead = {
        id: randomUUID(),
        instagram_handle: input.instagram_handle,
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

  async matchChunks(queryText: string, outcomes: string[], limit: number): Promise<ConversationChunk[]> {
    const db = await this.read();
    const query = new Set(tokenize(queryText));
    if (query.size === 0) return [];
    return db.chunks
      .filter((c) => outcomes.length === 0 || (c.outcome != null && outcomes.includes(c.outcome)))
      .map((c) => {
        const tokens = new Set(tokenize(`${c.content} ${c.niche ?? ""} ${c.stage ?? ""}`));
        let overlap = 0;
        for (const t of query) if (tokens.has(t)) overlap += 1;
        const union = new Set([...query, ...tokens]).size;
        return { ...c, similarity: union === 0 ? 0 : overlap / union };
      })
      .filter((c) => (c.similarity ?? 0) > 0)
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, limit);
  }
}
