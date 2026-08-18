import { TIER_WEIGHT, isNegativeTier, isPositiveTier } from "@/core/outcomes";
import { TIER_EVIDENCE, type ConversationChunk, type Lead, type OutcomeTier, type Qualification, type RetrievedExamples, type Strategy } from "@/lib/types";

/**
 * Reranks semantically-retrieved historical examples using structured signals.
 *
 * Semantic similarity alone puts a Not-Interested conversation next to an
 * Onboarding one whenever they share a niche. Reranking pushes downstream
 * quality, stage and situation into the ordering so the writer sees the right
 * evidence in the right category.
 */

export const CASSEY = "Cassey";

export type RerankInput = {
  lead: Lead;
  strategy: Strategy;
  /** Setter whose voice the final DM should sound like. */
  voiceSetter?: string;
};

/** How much each structured signal can contribute on top of similarity. */
const WEIGHTS = {
  similarity: 1.0,
  tier: 0.9,
  niche: 0.5,
  industry: 0.35,
  stage: 0.45,
  objective: 0.4,
  confusion: 0.6,
  objection: 0.35,
  qualificationShape: 0.3,
  mediaExperience: 0.25,
  quality: 0.3,
};

function str(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase() : "";
}

function meta(chunk: ConversationChunk, key: string): unknown {
  return chunk.metadata?.[key];
}

function overlaps(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = str(a);
  const y = str(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // Loose containment catches "SMB accounting software" vs "accounting".
  return x.includes(y) || y.includes(x);
}

/** Distance between two qualification profiles, 0 (identical) to 1 (opposite). */
function qualificationDistance(a: Qualification, b: Partial<Qualification>): number {
  const keys = Object.keys(a) as (keyof Qualification)[];
  let diff = 0;
  let counted = 0;
  for (const k of keys) {
    const other = b[k];
    if (typeof other !== "number") continue;
    diff += Math.abs((a[k] ?? 0) - other);
    counted += 1;
  }
  if (counted === 0) return 0.5;
  return diff / (counted * 2);
}

export function scoreChunk(chunk: ConversationChunk, input: RerankInput): { score: number; reasons: string[] } {
  const { lead, strategy } = input;
  const reasons: string[] = [];

  const similarity = chunk.similarity ?? 0;
  let score = similarity * WEIGHTS.similarity;

  const tier = (chunk.outcome_tier ?? null) as OutcomeTier | null;
  if (tier) {
    score += TIER_WEIGHT[tier] * WEIGHTS.tier;
    if (isPositiveTier(tier)) reasons.push(`Tier ${tier} outcome`);
    if (isNegativeTier(tier)) reasons.push(`Tier ${tier} — negative evidence`);
  }

  if (overlaps(chunk.niche, lead.niche)) {
    score += WEIGHTS.niche;
    reasons.push("same niche");
  }
  if (overlaps(chunk.industry, lead.industry)) {
    score += WEIGHTS.industry;
    reasons.push("same industry");
  }
  if (overlaps(chunk.stage, strategy.stage)) {
    score += WEIGHTS.stage;
    reasons.push("same conversation stage");
  }
  if (overlaps(str(meta(chunk, "next_objective")), strategy.next_objective)) {
    score += WEIGHTS.objective;
    reasons.push("same objective");
  }

  // SERVICE_CONFUSION examples are the single most useful evidence when the
  // current lead is confused — including the ones that handled it badly.
  const chunkConfusion = meta(chunk, "service_confusion") === true;
  if (strategy.service_confusion && chunkConfusion) {
    score += WEIGHTS.confusion;
    reasons.push("also involved service confusion");
  }

  const objection = str(meta(chunk, "objection_type"));
  if (objection && strategy.missing_information.some((m) => str(m).includes(objection))) {
    score += WEIGHTS.objection;
    reasons.push(`objection: ${objection}`);
  }

  const chunkQual = meta(chunk, "qualification") as Partial<Qualification> | undefined;
  if (chunkQual && typeof chunkQual === "object") {
    const distance = qualificationDistance(strategy.qualification, chunkQual);
    score += (1 - distance) * WEIGHTS.qualificationShape;
    if (distance < 0.25) reasons.push("similar qualification profile");
  }

  if (overlaps(str(meta(chunk, "media_experience")), lead.media_experience)) {
    score += WEIGHTS.mediaExperience;
    reasons.push("similar media experience");
  }

  if (typeof chunk.quality_score === "number") {
    score += (chunk.quality_score / 5) * WEIGHTS.quality;
  }

  return { score, reasons };
}

/**
 * Splits reranked chunks into the three labelled buckets the writer sees, plus a
 * separate set of voice examples.
 *
 * Strategy may be learned from the whole team; the final phrasing should sound
 * like one setter. Keeping voice examples in their own bucket is what stops a
 * strong result from another setter dragging the tone across.
 */
export function rerankAndBucket(
  chunks: ConversationChunk[],
  input: RerankInput,
  limits = { winners: 3, partial: 2, failures: 3, voice: 3 },
): RetrievedExamples {
  const voiceSetter = input.voiceSetter ?? CASSEY;

  const scored = chunks.map((chunk) => {
    const { score, reasons } = scoreChunk(chunk, input);
    const tier = (chunk.outcome_tier ?? null) as OutcomeTier | null;
    return {
      ...chunk,
      score,
      match_reasons: reasons,
      evidence_class: tier ? TIER_EVIDENCE[tier] : ("neutral" as const),
    };
  });

  const byScore = (a: ConversationChunk, b: ConversationChunk) => (b.score ?? 0) - (a.score ?? 0);
  const seen = new Set<string>();
  const take = (pool: ConversationChunk[], n: number) => {
    const out: ConversationChunk[] = [];
    for (const c of pool) {
      if (out.length >= n) break;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  };

  const strong = scored.filter((c) => c.evidence_class === "strong_winner").sort(byScore);
  const partial = scored.filter((c) => c.evidence_class === "partial_win").sort(byScore);
  const failed = scored.filter((c) => c.evidence_class === "failure").sort(byScore);

  const strong_winners = take(strong, limits.winners);
  const partial_wins = take(partial, limits.partial);
  const failures = take(failed, limits.failures);

  // Voice examples: this setter's own words, preferring conversations that went
  // well, but never a failure — we do not want to imitate the phrasing of a loss.
  const voice_examples = scored
    .filter((c) => str(c.setter_name) === str(voiceSetter) && c.evidence_class !== "failure")
    .sort(byScore)
    .slice(0, limits.voice);

  return { strong_winners, partial_wins, failures, voice_examples };
}

/**
 * Builds the retrieval query text. Kept separate so embeddings can be cached
 * against a stable key.
 */
export function buildQueryText(lead: Lead, strategy: Strategy, latestMessage: string): string {
  return [
    lead.industry,
    lead.niche,
    lead.commercial_goal,
    lead.media_gap,
    lead.media_experience,
    lead.authority_level,
    strategy.stage,
    strategy.next_objective,
    strategy.service_confusion ? "service confusion podcast guest invitation misunderstanding" : null,
    latestMessage,
  ]
    .filter(Boolean)
    .join(" | ");
}
