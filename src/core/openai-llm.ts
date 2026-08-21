import { getOpenAI, reviewModel, setterModel } from "@/core/openai";
import { REVIEWER_CHECKLIST, SYSTEM_PROMPT } from "@/core/prompts";
import { record } from "@/core/observability";
import { EXTRACTION_INSTRUCTIONS, type ExtractedMemory } from "@/core/memory-extract";
import { memoryExtractionSchema, reviewSchema, strategySchema } from "@/core/schemas";
import type { SetterLlm } from "@/core/llm";
import type { Review, Strategy } from "@/lib/types";

type ResponseLike = { output_text: string; usage?: { input_tokens?: number; output_tokens?: number } };

function logUsage(op: string, model: string, r: ResponseLike, ms: number) {
  record({ op, model, ms, tokens_in: r.usage?.input_tokens, tokens_out: r.usage?.output_tokens });
}

/** GPT-5.6 (or whatever OPENAI_MODEL names) running the strategy → reply → review passes. */
export const openaiLlm: SetterLlm = {
  engine: "openai",

  async strategy(_ctx, context) {
    const model = setterModel();
    const started = Date.now();
    const r = (await getOpenAI().responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: `Analyze the lead state before writing anything. Decide the next sales objective.

Score every dimension from qualification_evidence. Where you score higher than the evidence supports, put the exact words from the conversation that justify it in the "evidence" field — quotes are checked verbatim against the real messages and unverifiable ones are discarded.

Score service_understanding ONLY from the prospect's own words. Our own explanation does not raise it. If the prospect has shown confusion about what this is, set service_confusion and score service_understanding 0.

CONTEXT
${context}`,
      text: {
        format: { type: "json_schema", name: "setter_strategy", strict: true, schema: strategySchema },
      },
    })) as ResponseLike;
    logUsage("openai.strategy", model, r, Date.now() - started);
    return JSON.parse(r.output_text) as Strategy;
  },

  async reply(_ctx, context, strategy) {
    const model = setterModel();
    const started = Date.now();
    const r = (await getOpenAI().responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: `Write ONE exact Instagram DM for Cassey to send next. No explanation, no alternatives.

Make exactly the move in message_plan, and only that move. Never ask about anything conversation_state lists as already answered. Frame value in the terms given under motivation. Match the engagement guidance. Learn tone from voice_examples and strategy from similar_strong_winners; never imitate similar_failures.

STRATEGY
${JSON.stringify(strategy, null, 2)}

CONTEXT
${context}`,
    })) as ResponseLike;
    logUsage("openai.write", model, r, Date.now() - started);
    return r.output_text.trim();
  },

  async review(_ctx, context, strategy, draft, audit) {
    const model = reviewModel();
    const started = Date.now();
    const r = (await getOpenAI().responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: `${REVIEWER_CHECKLIST}

${audit}

STRATEGY
${JSON.stringify(strategy, null, 2)}

DRAFT
${draft}

CONTEXT
${context}`,
      text: {
        format: { type: "json_schema", name: "setter_review", strict: true, schema: reviewSchema },
      },
    })) as ResponseLike;
    logUsage("openai.review", model, r, Date.now() - started);
    return JSON.parse(r.output_text) as Review;
  },

  async extractMemory(transcript, alreadyKnown) {
    const model = reviewModel();
    const started = Date.now();
    const r = (await getOpenAI().responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: `${EXTRACTION_INSTRUCTIONS}

ALREADY REMEMBERED — do not propose any of this again
${alreadyKnown ?? "Nothing yet."}

NEW MESSAGES TO EXTRACT FROM
${transcript}`,
      text: {
        format: { type: "json_schema", name: "memory_extraction", strict: true, schema: memoryExtractionSchema },
      },
    })) as ResponseLike;
    logUsage("openai.memory", model, r, Date.now() - started);
    return JSON.parse(r.output_text) as ExtractedMemory;
  },
};
