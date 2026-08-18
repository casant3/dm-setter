import { getOpenAI, reviewModel, setterModel } from "@/core/openai";
import { SYSTEM_PROMPT } from "@/core/prompts";
import { reviewSchema, strategySchema } from "@/core/schemas";
import type { SetterLlm } from "@/core/llm";
import type { Review, Strategy } from "@/lib/types";

/** GPT-5.6 (or whatever OPENAI_MODEL names) running the strategy → reply → review passes. */
export const openaiLlm: SetterLlm = {
  engine: "openai",

  async strategy(_ctx, context) {
    const r = await getOpenAI().responses.create({
      model: setterModel(),
      instructions: SYSTEM_PROMPT,
      input: `Analyze the lead state before writing anything. Decide the next sales objective.\n\nCONTEXT\n${context}`,
      text: {
        format: { type: "json_schema", name: "setter_strategy", strict: true, schema: strategySchema },
      },
    });
    return JSON.parse(r.output_text) as Strategy;
  },

  async reply(_ctx, context, strategy) {
    const r = await getOpenAI().responses.create({
      model: setterModel(),
      instructions: SYSTEM_PROMPT,
      input: `Write ONE exact Instagram DM for Cassey to send next. No explanation. Follow the strategy and the actual conversation. Do not force a CTA if not call-ready.\n\nSTRATEGY\n${JSON.stringify(strategy, null, 2)}\n\nCONTEXT\n${context}`,
    });
    return r.output_text.trim();
  },

  async review(_ctx, context, strategy, draft) {
    const r = await getOpenAI().responses.create({
      model: reviewModel(),
      instructions: SYSTEM_PROMPT,
      input: `Audit the proposed reply. Check: already asked/answered; context contradiction; pitching too early; too passive; service confusion unresolved; value not built; credibility invented; unnatural/corporate tone; premature Avo CTA. If any issue exists, rewrite it.\n\nSTRATEGY\n${JSON.stringify(strategy, null, 2)}\n\nDRAFT\n${draft}\n\nCONTEXT\n${context}`,
      text: {
        format: { type: "json_schema", name: "setter_review", strict: true, schema: reviewSchema },
      },
    });
    return JSON.parse(r.output_text) as Review;
  },
};
