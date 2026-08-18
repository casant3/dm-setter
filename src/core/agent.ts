import { openai, setterModel, reviewModel } from "./openai.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { strategySchema, reviewSchema } from "./schemas.js";
import { loadLeadContext } from "./context.js";
import { db } from "./db.js";
import type { AgentResult, Strategy } from "./types.js";

function compactContext(ctx: any) {
  return JSON.stringify({
    lead: ctx.lead,
    lead_memory: ctx.memory,
    recent_messages: ctx.recentMessages,
    important_events: ctx.events,
    approved_credibility_assets: ctx.credibility,
    similar_successful_examples: ctx.similarWinners.map((x: any) => ({ outcome:x.outcome, stage:x.stage, content:x.content, metadata:x.metadata, similarity:x.similarity })),
    similar_failed_examples: ctx.similarLosses.map((x: any) => ({ outcome:x.outcome, stage:x.stage, content:x.content, metadata:x.metadata, similarity:x.similarity })),
    prospect_new_message: ctx.newMessage,
  }, null, 2);
}

async function getStrategy(context: string): Promise<Strategy> {
  const r = await openai.responses.create({
    model: setterModel,
    instructions: SYSTEM_PROMPT,
    input: `Analyze the lead state before writing anything. Decide the next sales objective.\n\nCONTEXT\n${context}`,
    text: { format: { type: "json_schema", name: "setter_strategy", strict: true, schema: strategySchema } },
  });
  return JSON.parse(r.output_text) as Strategy;
}

async function writeReply(context: string, strategy: Strategy): Promise<string> {
  const r = await openai.responses.create({
    model: setterModel,
    instructions: SYSTEM_PROMPT,
    input: `Write ONE exact Instagram DM for Cassey to send next. No explanation. Follow the strategy and the actual conversation. Do not force a CTA if not call-ready.\n\nSTRATEGY\n${JSON.stringify(strategy,null,2)}\n\nCONTEXT\n${context}`,
  });
  return r.output_text.trim();
}

async function reviewReply(context: string, strategy: Strategy, draft: string) {
  const r = await openai.responses.create({
    model: reviewModel,
    instructions: SYSTEM_PROMPT,
    input: `Audit the proposed reply. Check: already asked/answered; context contradiction; pitching too early; too passive; service confusion unresolved; value not built; credibility invented; unnatural/corporate tone; premature Avo CTA. If any issue exists, rewrite it.\n\nSTRATEGY\n${JSON.stringify(strategy,null,2)}\n\nDRAFT\n${draft}\n\nCONTEXT\n${context}`,
    text: { format: { type: "json_schema", name: "setter_review", strict: true, schema: reviewSchema } },
  });
  return JSON.parse(r.output_text);
}

export async function runSetter(handle: string, prospectMessage: string): Promise<AgentResult> {
  const ctx = await loadLeadContext(handle, prospectMessage);
  const context = compactContext(ctx);
  const strategy = await getStrategy(context);

  // deterministic hard-gate protection in addition to model judgment
  const q = strategy.qualification;
  const hardGate = q.fit > 0 && q.commercial_goal > 0 && q.service_understanding > 0 && strategy.total_score >= 9 && !strategy.service_confusion;
  strategy.call_ready = strategy.call_ready && hardGate;

  const draft = await writeReply(context, strategy);
  const reviewer = await reviewReply(context, strategy, draft);
  const finalReply = reviewer.final_reply?.trim() || draft;

  await db.from("ai_suggestions").insert({
    lead_id: ctx.lead.id,
    suggested_message: finalReply,
    strategy,
    context_used: { recent_message_count: ctx.recentMessages.length },
    examples_used: [...ctx.similarWinners, ...ctx.similarLosses].map((x:any)=>x.id),
  });

  return { strategy, reply: draft, reviewer: { ...reviewer, final_reply: finalReply } };
}
