import type { CredibilityAsset, Lead, Strategy } from "@/lib/types";

/**
 * Selects the few approved credibility assets worth showing for this prospect.
 *
 * Handing the model thirty proof points invites name-dropping and makes it more
 * likely something irrelevant gets used. Everything returned still comes from the
 * verified `credibility_assets` table — this only narrows, never invents.
 */

export const MIN_ASSETS = 2;
export const MAX_ASSETS = 5;

/**
 * Common words carry no matching signal. Without this filter an asset could score
 * a match purely on words like "for" or "the" and leak into context as relevant.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "they", "them", "their", "our", "you", "your",
  "are", "was", "were", "been", "has", "have", "had", "not", "but", "all", "any", "can", "who", "how",
  "what", "when", "which", "into", "over", "out", "off", "than", "then", "there", "here", "some",
  "more", "most", "other", "such", "only", "own", "same", "will", "would", "could", "should", "about",
  "before", "after", "real", "must", "may", "get", "got", "one", "two", "new", "now", "use", "used",
  "team", "work", "working", "help", "helped", "helping", "client", "clients", "record", "records",
]);

function tokens(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  const hits = a.filter((t) => set.has(t)).length;
  return hits / Math.min(a.length, b.length);
}

export function rankCredibility(
  assets: CredibilityAsset[],
  lead: Lead,
  strategy: Strategy,
  max = MAX_ASSETS,
): CredibilityAsset[] {
  if (assets.length === 0) return [];

  const leadNiche = tokens(lead.niche);
  const leadIndustry = tokens(lead.industry);
  const goal = tokens(lead.commercial_goal);
  const gap = tokens(lead.media_gap);
  const objective = tokens(strategy.next_objective);

  const scored = assets.map((asset) => {
    const assetNiches = (asset.niches ?? []).flatMap(tokens);
    const assetIndustries = (asset.industries ?? []).flatMap(tokens);
    const claim = tokens(asset.approved_claim);

    let score = 0;
    score += overlapScore(leadNiche, assetNiches) * 3;
    score += overlapScore(leadIndustry, assetIndustries) * 2.5;
    score += overlapScore(leadNiche, claim) * 1.2;
    score += overlapScore(leadIndustry, claim) * 1.0;
    score += overlapScore(goal, claim) * 1.5;
    score += overlapScore(gap, claim) * 1.2;
    score += overlapScore(objective, claim) * 0.6;

    // A case study proves an outcome, so prefer it while we are building value —
    // but only as a tie-break between assets that already match this prospect.
    // Applying it unconditionally would give an unrelated asset a positive score
    // and leak it into context.
    if (score > 0 && asset.asset_type === "case_study" && strategy.qualification.value_established < 2) {
      score += 0.4;
    }

    return { ...asset, relevance: Number(score.toFixed(4)) };
  });

  scored.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));

  const relevant = scored.filter((a) => (a.relevance ?? 0) > 0);

  // If nothing matches the prospect, return nothing rather than padding with
  // unrelated proof. The writer is instructed to cite nothing in that case.
  if (relevant.length === 0) return [];

  return relevant.slice(0, Math.max(1, max));
}
