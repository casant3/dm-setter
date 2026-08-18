import { getDb } from "@/core/db";
import { embeddingModel, getOpenAI, openaiConfigured } from "@/core/openai";
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

function unwrap<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
}

/** For `.single()` queries, where a missing row is a genuine error. */
function unwrapOne<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  const data = unwrap(res, what);
  if (data === null) throw new Error(`${what}: no row returned`);
  return data;
}

/** Supabase/Postgres — the source of truth for lead memory and retrieval. */
export class SupabaseStore implements Store {
  readonly mode = "supabase" as const;

  async listLeads(): Promise<LeadListItem[]> {
    const db = getDb();
    const res = await db.from("lead_inbox").select("*").order("last_activity_at", { ascending: false });
    const rows = unwrap(res, "listLeads");
    return (rows || []).map((row: Record<string, unknown>) => {
      const { last_activity_at: _ignored, ...lead } = row;
      return {
        ...(lead as unknown as Lead),
        message_count: Number(row.message_count ?? 0),
        last_message_at: (row.last_message_at as string) ?? null,
        last_message_preview: (row.last_message_preview as string) ?? null,
        last_message_sender: (row.last_message_sender as LeadListItem["last_message_sender"]) ?? null,
        awaiting_reply: row.last_message_sender === "prospect",
      };
    });
  }

  async getLead(id: string): Promise<Lead | null> {
    const db = getDb();
    return unwrap(await db.from("leads").select("*").eq("id", id).maybeSingle(), "getLead");
  }

  async getLeadByHandle(handle: string): Promise<Lead | null> {
    const db = getDb();
    return unwrap(
      await db.from("leads").select("*").eq("instagram_handle", handle).maybeSingle(),
      "getLeadByHandle",
    );
  }

  async createLead(input: NewLeadInput): Promise<Lead> {
    const db = getDb();
    return unwrapOne(await db.from("leads").insert(input).select("*").single(), "createLead");
  }

  async updateLead(id: string, patch: Partial<Lead>): Promise<Lead> {
    const db = getDb();
    return unwrapOne(
      await db
        .from("leads")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single(),
      "updateLead",
    );
  }

  async listMessages(leadId: string): Promise<Message[]> {
    const db = getDb();
    return (
      unwrap(
        await db.from("messages").select("*").eq("lead_id", leadId).order("sent_at", { ascending: true }),
        "listMessages",
      ) || []
    );
  }

  async recentMessages(leadId: string, limit: number): Promise<Message[]> {
    const db = getDb();
    return (
      unwrap(
        await db
          .from("messages")
          .select("*")
          .eq("lead_id", leadId)
          .order("sent_at", { ascending: false })
          .limit(limit),
        "recentMessages",
      ) || []
    );
  }

  async appendMessages(leadId: string, messages: NewMessageInput[]): Promise<Message[]> {
    if (messages.length === 0) return [];
    const db = getDb();
    const rows = messages.map((m) => ({
      lead_id: leadId,
      sender: m.sender,
      message_text: m.message_text,
      sent_at: m.sent_at ?? new Date().toISOString(),
      sent_by_ai: m.sent_by_ai ?? false,
      ai_suggestion_id: m.ai_suggestion_id ?? null,
    }));
    const inserted = unwrap(await db.from("messages").insert(rows).select("*"), "appendMessages") || [];

    const latest = rows.reduce((a, b) => (a.sent_at > b.sent_at ? a : b));
    await db
      .from("leads")
      .update({ last_contact_at: latest.sent_at, updated_at: new Date().toISOString() })
      .eq("id", leadId);
    return inserted;
  }

  async getMemory(leadId: string): Promise<LeadMemory | null> {
    const db = getDb();
    return unwrap(await db.from("lead_memories").select("*").eq("lead_id", leadId).maybeSingle(), "getMemory");
  }

  async upsertMemory(leadId: string, patch: Partial<LeadMemory>): Promise<LeadMemory> {
    const db = getDb();
    return unwrapOne(
      await db
        .from("lead_memories")
        .upsert({ ...patch, lead_id: leadId }, { onConflict: "lead_id" })
        .select("*")
        .single(),
      "upsertMemory",
    );
  }

  async listEvents(leadId: string, limit: number): Promise<ConversationEvent[]> {
    const db = getDb();
    return (
      unwrap(
        await db
          .from("conversation_events")
          .select("event_type,description,importance,happened_at")
          .eq("lead_id", leadId)
          .order("happened_at", { ascending: false })
          .limit(limit),
        "listEvents",
      ) || []
    );
  }

  async listCredibility(limit: number): Promise<CredibilityAsset[]> {
    const db = getDb();
    return (
      unwrap(
        await db
          .from("credibility_assets")
          .select("asset_type,name,approved_claim,niches")
          .eq("active", true)
          .limit(limit),
        "listCredibility",
      ) || []
    );
  }

  async listSuggestions(leadId: string): Promise<AiSuggestion[]> {
    const db = getDb();
    return (
      unwrap(
        await db
          .from("ai_suggestions")
          .select("*")
          .eq("lead_id", leadId)
          .order("created_at", { ascending: false })
          .limit(50),
        "listSuggestions",
      ) || []
    );
  }

  async createSuggestion(draft: SuggestionDraft): Promise<AiSuggestion> {
    const db = getDb();
    return unwrapOne(await db.from("ai_suggestions").insert(draft).select("*").single(), "createSuggestion");
  }

  async recordFeedback(suggestionId: string, input: FeedbackInput): Promise<AiSuggestion> {
    const db = getDb();
    // The legacy boolean columns are kept in sync so existing analytics keep working.
    const patch = {
      feedback: input.feedback,
      feedback_at: new Date().toISOString(),
      feedback_note: input.note ?? null,
      accepted: input.feedback !== "rejected",
      edited: input.feedback === "edited",
      rejected: input.feedback === "rejected",
      final_message_sent: input.final_message_sent ?? null,
    };
    return unwrapOne(
      await db.from("ai_suggestions").update(patch).eq("id", suggestionId).select("*").single(),
      "recordFeedback",
    );
  }

  async matchChunks(queryText: string, outcomes: string[], limit: number): Promise<ConversationChunk[]> {
    if (!openaiConfigured()) return [];
    const db = getDb();
    const emb = await getOpenAI().embeddings.create({ model: embeddingModel(), input: queryText });
    const res = await db.rpc("match_conversation_chunks", {
      query_embedding: emb.data[0].embedding,
      match_count: limit,
      filter_outcomes: outcomes,
    });
    if (res.error) throw new Error(`matchChunks: ${res.error.message}`);
    return (res.data as ConversationChunk[]) || [];
  }
}
