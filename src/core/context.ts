import { db } from "./db.js";
import { openai, embeddingModel } from "./openai.js";

export async function loadLeadContext(handle: string, newMessage: string) {
  const { data: lead, error } = await db.from("leads").select("*").eq("instagram_handle", handle).maybeSingle();
  if (error) throw error;
  if (!lead) throw new Error(`Lead not found: ${handle}`);

  const [messagesRes, memoryRes, eventsRes, credibilityRes] = await Promise.all([
    db.from("messages").select("sender,message_text,sent_at,is_objection,is_buying_signal").eq("lead_id", lead.id).order("sent_at", { ascending: false }).limit(16),
    db.from("lead_memories").select("*").eq("lead_id", lead.id).maybeSingle(),
    db.from("conversation_events").select("event_type,description,importance,happened_at").eq("lead_id", lead.id).order("happened_at", { ascending: false }).limit(12),
    db.from("credibility_assets").select("asset_type,name,approved_claim,niches").eq("active", true).limit(30),
  ]);

  const queryText = [lead.industry, lead.niche, lead.commercial_goal, lead.media_gap, newMessage].filter(Boolean).join(" | ");
  const emb = await openai.embeddings.create({ model: embeddingModel, input: queryText });
  const vector = emb.data[0].embedding;

  const winners = await db.rpc("match_conversation_chunks", {
    query_embedding: vector,
    match_count: 4,
    filter_outcomes: ["📞 Onboarding Call", "📞 Discovery Call"],
  });
  const losses = await db.rpc("match_conversation_chunks", {
    query_embedding: vector,
    match_count: 3,
    filter_outcomes: ["❌ Not Interested", "⚫ No show"],
  });

  return {
    lead,
    memory: memoryRes.data,
    recentMessages: [...(messagesRes.data || [])].reverse(),
    events: eventsRes.data || [],
    credibility: credibilityRes.data || [],
    similarWinners: winners.data || [],
    similarLosses: losses.data || [],
    newMessage,
  };
}
