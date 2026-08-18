import { createHash } from "node:crypto";
import { getDb } from "@/core/db";
import { embeddingModel, getOpenAI, openaiConfigured } from "@/core/openai";
import { emptyMemory } from "@/core/memory";
import { record } from "@/core/observability";
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
} from "@/lib/types";
import type { FeedbackInput, FeedbackStats, Store, SuggestionDraft } from "@/lib/store/store";

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

/**
 * Process-local embedding cache.
 *
 * Retrieval queries repeat heavily while a setter works one lead, and embeddings
 * are the only per-request network cost that is trivially cacheable.
 */
const embeddingCache = new Map<string, number[]>();
const EMBEDDING_CACHE_LIMIT = 500;

async function embed(text: string): Promise<number[]> {
  const key = createHash("sha256").update(`${embeddingModel()}:${text}`).digest("hex");
  const hit = embeddingCache.get(key);
  if (hit) {
    record({ op: "embedding", ms: 0, cached: true });
    return hit;
  }
  const started = Date.now();
  const res = await getOpenAI().embeddings.create({ model: embeddingModel(), input: text });
  const vector = res.data[0].embedding;
  record({ op: "embedding", ms: Date.now() - started, model: embeddingModel(), tokens_in: res.usage?.prompt_tokens });
  if (embeddingCache.size >= EMBEDDING_CACHE_LIMIT) {
    embeddingCache.delete(embeddingCache.keys().next().value as string);
  }
  embeddingCache.set(key, vector);
  return vector;
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
    return unwrap(await getDb().from("leads").select("*").eq("id", id).maybeSingle(), "getLead");
  }

  async getLeadByHandle(handle: string): Promise<Lead | null> {
    return unwrap(
      await getDb().from("leads").select("*").eq("instagram_handle", handle).maybeSingle(),
      "getLeadByHandle",
    );
  }

  async createLead(input: NewLeadInput): Promise<Lead> {
    return unwrapOne(await getDb().from("leads").insert(input).select("*").single(), "createLead");
  }

  async updateLead(id: string, patch: Partial<Lead>): Promise<Lead> {
    return unwrapOne(
      await getDb()
        .from("leads")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select("*")
        .single(),
      "updateLead",
    );
  }

  async listMessages(leadId: string): Promise<Message[]> {
    return (
      unwrap(
        await getDb().from("messages").select("*").eq("lead_id", leadId).order("sent_at", { ascending: true }),
        "listMessages",
      ) || []
    );
  }

  async recentMessages(leadId: string, limit: number): Promise<Message[]> {
    return (
      unwrap(
        await getDb()
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
    return unwrap(await getDb().from("lead_memories").select("*").eq("lead_id", leadId).maybeSingle(), "getMemory");
  }

  async upsertMemory(leadId: string, patch: Partial<LeadMemory>): Promise<LeadMemory> {
    const existing = await this.getMemory(leadId);
    const merged = { ...(existing ?? emptyMemory(leadId)), ...patch, lead_id: leadId };
    return unwrapOne(
      await getDb().from("lead_memories").upsert(merged, { onConflict: "lead_id" }).select("*").single(),
      "upsertMemory",
    );
  }

  async listEvents(leadId: string, limit: number): Promise<ConversationEvent[]> {
    return (
      unwrap(
        await getDb()
          .from("conversation_events")
          .select("event_type,description,importance,happened_at")
          .eq("lead_id", leadId)
          .order("happened_at", { ascending: false })
          .limit(limit),
        "listEvents",
      ) || []
    );
  }

  async addEvent(leadId: string, event: Omit<ConversationEvent, "id">): Promise<void> {
    const res = await getDb().from("conversation_events").insert({ ...event, lead_id: leadId });
    if (res.error) throw new Error(`addEvent: ${res.error.message}`);
  }

  async listCredibility(limit: number): Promise<CredibilityAsset[]> {
    return (
      unwrap(
        await getDb()
          .from("credibility_assets")
          .select("id,asset_type,name,approved_claim,niches,industries")
          .eq("active", true)
          .limit(limit),
        "listCredibility",
      ) || []
    );
  }

  async listSuggestions(leadId: string): Promise<AiSuggestion[]> {
    return (
      unwrap(
        await getDb()
          .from("ai_suggestions")
          .select("*")
          .eq("lead_id", leadId)
          .order("created_at", { ascending: false })
          .limit(50),
        "listSuggestions",
      ) || []
    );
  }

  async getSuggestion(id: string): Promise<AiSuggestion | null> {
    return unwrap(await getDb().from("ai_suggestions").select("*").eq("id", id).maybeSingle(), "getSuggestion");
  }

  async createSuggestion(draft: SuggestionDraft): Promise<AiSuggestion> {
    return unwrapOne(await getDb().from("ai_suggestions").insert(draft).select("*").single(), "createSuggestion");
  }

  async recordFeedback(suggestionId: string, input: FeedbackInput): Promise<AiSuggestion> {
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
      await getDb().from("ai_suggestions").update(patch).eq("id", suggestionId).select("*").single(),
      "recordFeedback",
    );
  }

  async feedbackStats(): Promise<FeedbackStats> {
    const db = getDb();
    const [byFeedback, byStage, edits] = await Promise.all([
      db.from("suggestion_feedback_stats").select("*"),
      db.from("strategy_performance").select("*"),
      db
        .from("ai_suggestions")
        .select("suggested_message,final_message_sent,strategy,feedback_at")
        .eq("feedback", "edited")
        .not("final_message_sent", "is", null)
        .order("feedback_at", { ascending: false })
        .limit(25),
    ]);

    return {
      by_feedback: (unwrap(byFeedback, "feedbackStats") || []).map((r: Record<string, unknown>) => ({
        feedback: String(r.feedback),
        count: Number(r.suggestions ?? 0),
        avg_score: r.avg_qualification_score == null ? null : Number(r.avg_qualification_score),
      })),
      by_stage: (unwrap(byStage, "strategyPerformance") || []).map((r: Record<string, unknown>) => ({
        stage: String(r.stage ?? "UNKNOWN"),
        used: Number(r.used ?? 0),
        edited: Number(r.edited ?? 0),
        rejected: Number(r.rejected ?? 0),
      })),
      recent_edits: (unwrap(edits, "recentEdits") || []).map((r: Record<string, unknown>) => ({
        suggested: String(r.suggested_message ?? ""),
        sent: String(r.final_message_sent ?? ""),
        stage: String((r.strategy as { stage?: string } | null)?.stage ?? "UNKNOWN"),
        at: String(r.feedback_at ?? ""),
      })),
    };
  }

  async matchChunks(queryText: string, limit: number): Promise<ConversationChunk[]> {
    if (!openaiConfigured()) return [];
    const vector = await embed(queryText);
    const res = await getDb().rpc("match_conversation_chunks", {
      query_embedding: vector,
      match_count: limit,
      filter_outcomes: null,
    });
    if (res.error) throw new Error(`matchChunks: ${res.error.message}`);
    const rows = (res.data as ConversationChunk[]) || [];
    record({ op: "matchChunks", ms: 0, count: rows.length });
    return rows;
  }

  async listSourceConversations(status?: string): Promise<SourceConversation[]> {
    let query = getDb().from("source_conversations").select("*").order("instagram_handle");
    if (status) query = query.eq("status", status);
    return unwrap(await query, "listSourceConversations") || [];
  }

  async getSourceConversation(id: string): Promise<SourceConversation | null> {
    return unwrap(
      await getDb().from("source_conversations").select("*").eq("id", id).maybeSingle(),
      "getSourceConversation",
    );
  }

  async upsertSourceConversation(
    row: Partial<SourceConversation> & { external_card_id: string },
  ): Promise<SourceConversation> {
    const db = getDb();
    const existing = unwrap(
      await db.from("source_conversations").select("*").eq("external_card_id", row.external_card_id).maybeSingle(),
      "upsertSourceConversation.lookup",
    );

    // A verified transcript is never overwritten by a re-ingest.
    const payload =
      existing?.status === "verified"
        ? { ...row, transcript: existing.transcript, labels: existing.labels, status: existing.status }
        : row;

    return unwrapOne(
      await db.from("source_conversations").upsert(payload, { onConflict: "external_card_id" }).select("*").single(),
      "upsertSourceConversation",
    );
  }

  async replaceChunksForConversation(
    conversationId: string,
    chunks: Omit<ConversationChunk, "id" | "similarity">[],
  ): Promise<number> {
    const db = getDb();
    const del = await db.from("conversation_chunks").delete().eq("source_conversation_id", conversationId);
    if (del.error) throw new Error(`replaceChunks.delete: ${del.error.message}`);
    if (chunks.length === 0) return 0;

    const rows = [] as Record<string, unknown>[];
    for (const chunk of chunks) {
      rows.push({
        source_conversation_id: conversationId,
        outcome: chunk.outcome,
        outcome_tier: chunk.outcome_tier,
        stage: chunk.stage,
        niche: chunk.niche,
        industry: chunk.industry,
        setter_name: chunk.setter_name,
        content: chunk.content,
        metadata: chunk.metadata,
        quality_score: chunk.quality_score,
        embedding: await embed(chunk.content),
      });
    }
    const ins = await db.from("conversation_chunks").insert(rows);
    if (ins.error) throw new Error(`replaceChunks.insert: ${ins.error.message}`);
    return rows.length;
  }
}
