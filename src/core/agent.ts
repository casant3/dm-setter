import { compactContext, enrichContext, loadLeadContext, type LeadContext } from "@/core/context";
import { evaluateGate, totalScore } from "@/core/gate";
import { applyExchangeToMemory } from "@/core/memory";
import { offlineLlm } from "@/core/offline-llm";
import { openaiConfigured } from "@/core/openai";
import { openaiLlm } from "@/core/openai-llm";
import { timed } from "@/core/observability";
import type { SetterLlm } from "@/core/llm";
import { getStore } from "@/lib/store";
import type { Store } from "@/lib/store/store";
import type { AgentResult, Strategy } from "@/lib/types";

export { evaluateGate } from "@/core/gate";

export type AgentDeps = { store: Store; llm: SetterLlm; voiceSetter?: string };

export function defaultDeps(): AgentDeps {
  return {
    store: getStore(),
    llm: openaiConfigured() ? openaiLlm : offlineLlm,
    voiceSetter: process.env.SETTER_VOICE || "Cassey",
  };
}

/**
 * Reconciles the model's qualification with what the conversation actually
 * evidences.
 *
 * The strategist can be talked into a high service_understanding by its own
 * explanation. Understanding is recomputed from the prospect's messages and the
 * lower of the two is kept, so optimism can never open the gate.
 */
function reconcileWithEvidence(strategy: Strategy, ctx: LeadContext): Strategy {
  const evidenced = ctx.understanding.level;
  const qualification = {
    ...strategy.qualification,
    service_understanding: Math.min(strategy.qualification.service_understanding, evidenced),
  };

  const confusion = ctx.understanding.confusion;
  const service_confusion = strategy.service_confusion || confusion !== null;

  return {
    ...strategy,
    qualification,
    total_score: totalScore(qualification),
    service_confusion,
    confusion_reason: strategy.confusion_reason ?? confusion?.reason ?? null,
    should_explain_service: strategy.should_explain_service || service_confusion || evidenced < 1,
  };
}

/** Strategy → evidence reconciliation → hard gate → writer → reviewer → persist. */
export async function runSetterForContext(
  ctx: LeadContext,
  deps: AgentDeps,
  options: { persist?: boolean } = {},
): Promise<AgentResult> {
  const timings: Record<string, number> = {};

  // Pass 1: strategy, on a cheap context with no embeddings computed yet.
  const preContext = compactContext(ctx);
  const { result: rawStrategy, ms: strategyMs } = await timed("strategy", () => deps.llm.strategy(ctx, preContext));
  timings.strategy = strategyMs;

  const strategy = reconcileWithEvidence(rawStrategy, ctx);

  // The gate is deterministic and final: the model never overrides it.
  const gate = evaluateGate(strategy);
  strategy.call_ready = strategy.call_ready && gate.passed;

  // Pass 2: retrieval and credibility, now that we know the objective.
  const { result: enriched, ms: retrievalMs } = await timed(
    "retrieval",
    () => enrichContext(deps.store, ctx, strategy, { voiceSetter: deps.voiceSetter }),
    {
      count: 0,
    },
  );
  timings.retrieval = retrievalMs;

  const context = compactContext(enriched);

  const { result: draft, ms: writeMs } = await timed("write", () => deps.llm.reply(enriched, context, strategy));
  timings.write = writeMs;

  const { result: reviewer, ms: reviewMs } = await timed("review", () => deps.llm.review(enriched, context, strategy, draft));
  timings.review = reviewMs;

  const finalReply = reviewer.final_reply?.trim() || draft;

  let suggestionId: string | null = null;
  if (options.persist !== false) {
    const saved = await deps.store.createSuggestion({
      lead_id: ctx.lead.id,
      suggested_message: finalReply,
      strategy,
      context_used: {
        recent_message_count: ctx.recentMessages.length,
        engine: deps.llm.engine,
        gate,
        understanding: {
          level: enriched.understanding.level,
          service_explained: Boolean(ctx.memory?.service_explained),
          confusion: enriched.understanding.confusion?.reason ?? null,
        },
        credibility_used: enriched.credibility.map((c) => c.name),
        example_tiers: {
          strong: enriched.examples.strong_winners.map((c) => c.outcome_tier),
          partial: enriched.examples.partial_wins.map((c) => c.outcome_tier),
          failure: enriched.examples.failures.map((c) => c.outcome_tier),
        },
        voice_setter: deps.voiceSetter,
        timings,
      },
      examples_used: [
        ...enriched.examples.strong_winners,
        ...enriched.examples.partial_wins,
        ...enriched.examples.failures,
      ].map((x) => x.id),
    });
    suggestionId = saved.id;
  }

  return {
    suggestion_id: suggestionId,
    strategy,
    reply: draft,
    reviewer: { ...reviewer, final_reply: finalReply },
    gate,
    examples: enriched.examples,
    credibility_used: enriched.credibility,
    understanding: {
      level: enriched.understanding.level,
      service_explained: Boolean(ctx.memory?.service_explained),
      evidence: enriched.understanding.evidence,
      confusion_reason: enriched.understanding.confusion?.reason ?? null,
    },
    engine: deps.llm.engine,
    timings,
  };
}

export async function runSetterForLead(
  leadId: string,
  prospectMessage: string,
  deps: AgentDeps = defaultDeps(),
): Promise<AgentResult> {
  const ctx = await loadLeadContext(deps.store, leadId, prospectMessage);
  return runSetterForContext(ctx, deps);
}

/** Handle-based entry point, kept for the CLI. */
export async function runSetter(
  handle: string,
  prospectMessage: string,
  deps: AgentDeps = defaultDeps(),
): Promise<AgentResult> {
  const lead = await deps.store.getLeadByHandle(handle);
  if (!lead) throw new Error(`Lead not found: ${handle}`);
  return runSetterForLead(lead.id, prospectMessage, deps);
}

/**
 * Advances permanent memory after a message was actually sent.
 *
 * Called from the feedback route, because "the setter sent this" is the moment
 * an exchange becomes real.
 */
export async function recordExchange(
  store: Store,
  leadId: string,
  strategy: Strategy,
  sentMessage: string,
): Promise<void> {
  const [memory, messages] = await Promise.all([store.getMemory(leadId), store.listMessages(leadId)]);
  const patch = applyExchangeToMemory(memory, leadId, {
    strategy,
    sentMessage,
    prospectMessages: messages.filter((m) => m.sender === "prospect"),
  });
  await store.upsertMemory(leadId, patch);
}
