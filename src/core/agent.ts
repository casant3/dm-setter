import { compactContext, loadLeadContext, type LeadContext } from "@/core/context";
import { openaiConfigured } from "@/core/openai";
import { offlineLlm } from "@/core/offline-llm";
import { openaiLlm } from "@/core/openai-llm";
import type { SetterLlm } from "@/core/llm";
import { getStore } from "@/lib/store";
import type { Store } from "@/lib/store/store";
import type { AgentResult, GateResult, Strategy } from "@/lib/types";

export type AgentDeps = { store: Store; llm: SetterLlm };

export function defaultDeps(): AgentDeps {
  return { store: getStore(), llm: openaiConfigured() ? openaiLlm : offlineLlm };
}

/**
 * Deterministic hard gate applied on top of the model's own judgement.
 *
 * A call is never recommended without fit, a commercial goal and service
 * understanding, a total of at least 9/12, and no unresolved SERVICE_CONFUSION.
 */
export function evaluateGate(strategy: Strategy): GateResult {
  const q = strategy.qualification;
  const blockers: string[] = [];
  if (q.fit === 0) blockers.push("No established fit");
  if (q.commercial_goal === 0) blockers.push("No commercial or authority goal");
  if (q.service_understanding === 0) blockers.push("Prospect does not understand this is a paid professional service");
  if (strategy.total_score < 9) blockers.push(`Qualification total ${strategy.total_score}/12 is below the 9 needed`);
  if (strategy.service_confusion) blockers.push("SERVICE_CONFUSION is unresolved");
  return { passed: blockers.length === 0, blockers, model_said_call_ready: strategy.call_ready };
}

/** Strategy pass → hard gate → reply writer → reviewer, then persist the suggestion. */
export async function runSetterForContext(
  ctx: LeadContext,
  deps: AgentDeps,
  options: { persist?: boolean } = {},
): Promise<AgentResult> {
  const context = compactContext(ctx);
  const strategy = await deps.llm.strategy(ctx, context);

  const gate = evaluateGate(strategy);
  strategy.call_ready = strategy.call_ready && gate.passed;

  const draft = await deps.llm.reply(ctx, context, strategy);
  const reviewer = await deps.llm.review(ctx, context, strategy, draft);
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
      },
      examples_used: [...ctx.similarWinners, ...ctx.similarLosses].map((x) => x.id),
    });
    suggestionId = saved.id;
  }

  return {
    suggestion_id: suggestionId,
    strategy,
    reply: draft,
    reviewer: { ...reviewer, final_reply: finalReply },
    gate,
    similar_winners: ctx.similarWinners,
    similar_failures: ctx.similarLosses,
    engine: deps.llm.engine,
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
