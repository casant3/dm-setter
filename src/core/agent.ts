import { auditDraft, auditForReviewer } from "@/core/audit";
import { compactContext, enrichContext, loadLeadContext, type LeadContext } from "@/core/context";
import { evaluateGate, totalScore } from "@/core/gate";
import { planMessage } from "@/core/message-plan";
import { reconcileQualification } from "@/core/qualification-evidence";
import { applyExchangeToMemory } from "@/core/memory";
import { buildExtractionInput, memoryPatchFromExtraction } from "@/core/memory-extract";
import { offlineLlm } from "@/core/offline-llm";
import { openaiConfigured } from "@/core/openai";
import { openaiLlm } from "@/core/openai-llm";
import { record, timed } from "@/core/observability";
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

  // Every dimension is capped at what the conversation actually evidences. A
  // quote the strategist supplies is worth one extra point — but only once it
  // has been found verbatim in the thread.
  const { qualification: capped, adjustments } = reconcileQualification(
    strategy.qualification,
    ctx.evidence,
    strategy.evidence ?? [],
    ctx.allMessages,
  );

  const qualification = {
    ...capped,
    service_understanding: Math.min(capped.service_understanding, evidenced),
  };

  const confusion = ctx.understanding.confusion;
  const service_confusion = strategy.service_confusion || confusion !== null;

  return {
    ...strategy,
    qualification,
    total_score: totalScore(qualification),
    evidence_adjustments: adjustments,
    service_confusion,
    confusion_reason: strategy.confusion_reason ?? confusion?.reason ?? null,
    should_explain_service:
      strategy.should_explain_service ||
      service_confusion ||
      ctx.understanding.commercial_clarity_needed !== null ||
      evidenced < 1,
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

  // One move, chosen deterministically from the state — not left to the writer.
  const plan = planMessage({
    dialogue: ctx.dialogue,
    understanding: ctx.understanding,
    brushOff: ctx.brushOff,
    temperature: ctx.temperature,
    gate,
    clarificationSpent: ctx.clarificationSpent,
    booking: ctx.booking,
    noShow: ctx.noShow,
    verifiedResearch: (ctx.memory?.research_facts ?? []).filter((f) => f.verified),
    slotProposal: ctx.slotProposal,
  });
  ctx.plan = plan;

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

  const auditInput = { dialogue: ctx.dialogue, motivation: ctx.motivation, plan };
  const draftAudit = auditDraft(draft, auditInput);

  const { result: reviewer, ms: reviewMs } = await timed("review", () =>
    deps.llm.review(enriched, context, strategy, draft, auditForReviewer(draftAudit)),
  );
  timings.review = reviewMs;

  const finalReply = reviewer.final_reply?.trim() || draft;

  // The same checks run again on what the reviewer produced: a rewrite must not
  // reintroduce what the draft was rejected for.
  const finalAudit = auditDraft(finalReply, auditInput);
  const review: typeof reviewer = {
    ...reviewer,
    final_reply: finalReply,
    approved: reviewer.approved && finalAudit.ok,
    issues: [...reviewer.issues, ...finalAudit.violations.filter((v) => v.severity === "hard").map((v) => v.detail)],
    message_purpose: reviewer.message_purpose || plan.purpose,
    desired_response: reviewer.desired_response || plan.desired_response,
    next_if_positive: reviewer.next_if_positive || plan.next_if_positive,
    next_if_negative: reviewer.next_if_negative || plan.next_if_negative,
    next_if_no_reply: reviewer.next_if_no_reply || plan.next_if_no_reply,
  };

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
          commercial_clarity_needed: enriched.understanding.commercial_clarity_needed?.reason ?? null,
        },
        plan,
        booking: { state: ctx.booking.state, no_show_risk: ctx.noShow.risk, slots_offered: plan.slots.map((s) => s.label) },
        audit: finalAudit,
        evidence_adjustments: strategy.evidence_adjustments ?? [],
        temperature: ctx.temperature.temperature,
        motivation: ctx.motivation.primary,
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
    reviewer: review,
    gate,
    examples: enriched.examples,
    credibility_used: enriched.credibility,
    understanding: {
      level: enriched.understanding.level,
      service_explained: Boolean(ctx.memory?.service_explained),
      evidence: enriched.understanding.evidence,
      confusion_reason: enriched.understanding.confusion?.reason ?? null,
      commercial_clarity_needed: enriched.understanding.commercial_clarity_needed?.reason ?? null,
    },
    plan: {
      move: plan.move,
      purpose: review.message_purpose ?? plan.purpose,
      desired_response: review.desired_response ?? plan.desired_response,
      next_if_positive: review.next_if_positive ?? plan.next_if_positive,
      next_if_negative: review.next_if_negative ?? plan.next_if_negative,
      next_if_no_reply: review.next_if_no_reply ?? plan.next_if_no_reply,
    },
    audit: {
      ok: finalAudit.ok,
      violations: finalAudit.violations,
      words: finalAudit.words,
    },
    booking: {
      state: ctx.booking.state,
      next_action: ctx.booking.next_action,
      slots: plan.slots.map((s) => s.label),
      no_show_risk: ctx.noShow.risk,
      no_show_factors: ctx.noShow.factors,
      no_show_mitigation: ctx.noShow.mitigation,
    },
    read: {
      temperature: ctx.temperature.temperature,
      motivation: ctx.motivation.primary,
      already_answered: ctx.dialogue.do_not_ask,
      brush_off: ctx.brushOff.kind === "none" ? null : ctx.brushOff.kind,
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
  llm?: SetterLlm,
): Promise<void> {
  const [memory, messages] = await Promise.all([store.getMemory(leadId), store.listMessages(leadId)]);
  const patch = applyExchangeToMemory(memory, leadId, {
    strategy,
    sentMessage,
    prospectMessages: messages.filter((m) => m.sender === "prospect"),
  });
  await store.upsertMemory(leadId, patch);

  // The richer, model-driven pass runs second and on the updated memory, so it
  // can never overwrite what the deterministic pass just established — or any
  // field a human has corrected.
  const extractor = llm ?? defaultDeps().llm;
  if (!extractor.extractMemory) return;

  const current = await store.getMemory(leadId);
  const input = buildExtractionInput(current, messages);

  // Nothing new to read: the last run already covered every message. Calling the
  // model again would spend a request re-deriving memory it has already
  // produced, and risk paraphrasing a settled fact into a near-duplicate.
  if (input.skip) {
    record({ op: "memory.skipped", ms: 0, count: 0 });
    return;
  }

  try {
    const extraction = await timed(
      "memory",
      () => extractor.extractMemory!(input.transcript, input.alreadyKnown),
      { count: input.newMessages.length },
    );
    const { patch: extracted, stats } = memoryPatchFromExtraction(current, leadId, extraction.result, messages, {
      messagesConsidered: input.newMessages.length,
    });
    await store.upsertMemory(leadId, { ...extracted, extraction_state: input.state });
    record({
      op: "memory.extracted",
      ms: extraction.ms,
      count: stats.proposed,
      // Counts only — never the remembered text itself.
      extra: {
        considered: stats.messages_considered,
        facts: stats.facts,
        inferences: stats.inferences,
        duplicates: stats.duplicates_ignored,
        human_fields_skipped: stats.human_fields_skipped,
      },
    });
  } catch (error) {
    // Memory extraction is an enhancement, not a precondition: a failure here
    // must never lose the exchange that has already been recorded.
    console.error("memory extraction failed", error);
  }
}
