import type { LeadMemory, Message } from "@/lib/types";

/**
 * What actually motivates this prospect.
 *
 * "Commercial goal" was being read too literally as *money*, which makes the
 * setter ask a doctor focused on patient education "what revenue are you trying
 * to generate?" — tone-deaf, and a reliable way to lose a good-fit lead. A
 * commercial goal is any outcome the prospect is working toward; the frame is
 * how we talk about it.
 */

export const MOTIVATION_FRAMES = [
  "revenue",
  "customers",
  "business_growth",
  "fundraising",
  "launch",
  "authority",
  "reputation",
  "thought_leadership",
  "client_education",
  "mission",
  "advocacy",
  "recruiting",
  "personal_brand",
  "founder_story",
  "legacy",
  "industry_influence",
  "credibility",
  "community",
] as const;
export type MotivationFrame = (typeof MOTIVATION_FRAMES)[number];

/** How to talk to someone in this frame, and what would land badly. */
export const FRAME_GUIDANCE: Record<MotivationFrame, { angle: string; avoid: string }> = {
  revenue: { angle: "revenue and pipeline impact", avoid: "vague brand talk with no commercial link" },
  customers: { angle: "reaching more of the right customers", avoid: "abstract prestige framing" },
  business_growth: { angle: "growth of the business itself", avoid: "personal-fame framing" },
  fundraising: { angle: "credibility that survives investor diligence", avoid: "audience-size or reach metrics" },
  launch: { angle: "having credibility live before the launch date", avoid: "open-ended timelines" },
  authority: { angle: "being recognised as the authority in their field", avoid: "pure revenue framing" },
  reputation: { angle: "what people find and believe about them", avoid: "growth-hacking language" },
  thought_leadership: { angle: "shaping the conversation in their industry", avoid: "transactional lead-gen framing" },
  client_education: { angle: "reaching and correctly informing more clients", avoid: "asking what revenue they want from media" },
  mission: { angle: "advancing the mission and reaching people who need it", avoid: "money-first questions" },
  advocacy: { angle: "moving public understanding on the issue", avoid: "commercial ROI framing" },
  recruiting: { angle: "attracting the people they want to hire", avoid: "consumer-audience framing" },
  personal_brand: { angle: "how they are perceived personally", avoid: "purely corporate framing" },
  founder_story: { angle: "getting their story told properly", avoid: "generic exposure talk" },
  legacy: { angle: "the record that outlasts the current work", avoid: "short-term metrics" },
  industry_influence: { angle: "influence with peers and industry gatekeepers", avoid: "consumer reach framing" },
  credibility: { angle: "third-party proof that they are the real thing", avoid: "follower-count framing" },
  community: { angle: "serving and growing their community", avoid: "extractive sales framing" },
};

/** Money framing is actively wrong for these. */
const NON_COMMERCIAL_FRAMES: MotivationFrame[] = [
  "client_education",
  "mission",
  "advocacy",
  "legacy",
  "community",
  "thought_leadership",
];

const FRAME_PATTERNS: { frame: MotivationFrame; re: RegExp }[] = [
  { frame: "fundraising", re: /\b(rais\w*|seed|series [a-c]|investors?|funding|round|vc|diligence)\b/i },
  { frame: "launch", re: /\b(launch\w*|releasing|going live|opening|drops? in)\b/i },
  { frame: "client_education", re: /\b(educat\w*|inform\w*)\b.{0,30}\b(patients?|clients?|people|public|audience)\b/i },
  { frame: "client_education", re: /\b(patients?|clients?)\b.{0,30}\b(understand|educat\w*|misinform\w*|misconcept\w*)\b/i },
  { frame: "mission", re: /\b(mission|purpose|why i do|give back|impact|help people|change lives)\b/i },
  { frame: "advocacy", re: /\b(advocac\w*|awareness|campaign|stigma|policy|misconcept\w*)\b/i },
  { frame: "recruiting", re: /\b(hiring|recruit\w*|talent|team growth|attract .{0,15}(people|engineers|staff))\b/i },
  { frame: "revenue", re: /\b(revenue|sales|mrr|arr|profit|monetis|monetiz|deals|clients paying)\b/i },
  { frame: "customers", re: /\b(customers?|leads?|bookings?|sign[- ]?ups?)\b/i },
  { frame: "authority", re: /\b(authority|expert|go[- ]to|recognised|recognized|respected)\b/i },
  { frame: "thought_leadership", re: /\b(thought leader\w*|shape the conversation|industry voice)\b/i },
  { frame: "credibility", re: /\b(credibilit\w*|legit\w*|trust|proof|vouch)\b/i },
  { frame: "reputation", re: /\b(reputation|how i'?m perceived|what people think)\b/i },
  { frame: "personal_brand", re: /\b(personal brand|my brand|my name)\b/i },
  { frame: "founder_story", re: /\b(my story|our story|founder story|journey)\b/i },
  { frame: "industry_influence", re: /\b(industry|peers|space|field)\b.{0,25}\b(influence|known|respected|leader)\b/i },
  { frame: "community", re: /\b(community|followers|members|tribe)\b/i },
  { frame: "legacy", re: /\b(legacy|long term|outlast|remembered)\b/i },
  { frame: "business_growth", re: /\b(grow\w* the business|scal\w*|expand\w*|next level)\b/i },
];

export type MotivationAssessment = {
  frames: { frame: MotivationFrame; quote: string; message_id: string | null }[];
  /** The frame to lead with, or null when nothing is evidenced yet. */
  primary: MotivationFrame | null;
  /** True when a money-first question would land badly. */
  avoid_money_framing: boolean;
  guidance: string | null;
};

/**
 * Infers the motivation frame from the prospect's own words only.
 *
 * Never guesses: with no evidence the frame is null and the setter asks an
 * open question rather than assuming what someone cares about.
 */
export function assessMotivation(
  prospectMessages: Pick<Message, "id" | "message_text">[],
  memory: LeadMemory | null,
): MotivationAssessment {
  const found: MotivationAssessment["frames"] = [];
  const seen = new Set<MotivationFrame>();

  const consider = (text: string, id: string | null) => {
    if (!text?.trim()) return;
    for (const { frame, re } of FRAME_PATTERNS) {
      if (seen.has(frame)) continue;
      if (re.test(text)) {
        seen.add(frame);
        found.push({ frame, quote: text.slice(0, 200), message_id: id });
      }
    }
  };

  for (const m of prospectMessages) consider(m.message_text, m.id ?? null);
  // Memory carries goals stated long before the current window.
  for (const item of memory?.goals ?? []) consider(String(item.value), item.source_message_id ?? null);
  for (const item of memory?.personal_goals ?? []) consider(String(item.value), item.source_message_id ?? null);

  // A non-commercial frame outranks a commercial one when both appear: the
  // penalty for money-framing a mission-driven prospect is far higher than the
  // reverse.
  const nonCommercial = found.find((f) => NON_COMMERCIAL_FRAMES.includes(f.frame));
  const primary = (nonCommercial ?? found[0])?.frame ?? null;

  return {
    frames: found,
    primary,
    avoid_money_framing: found.some((f) => NON_COMMERCIAL_FRAMES.includes(f.frame)),
    guidance: primary ? FRAME_GUIDANCE[primary].angle : null,
  };
}

/** True when a draft pushes a money frame at someone who is not motivated by money. */
export function draftMisframesMotivation(draft: string, motivation: MotivationAssessment): boolean {
  if (!motivation.avoid_money_framing) return false;
  return /\b(revenue|monetis|monetiz|roi|profit|how much (are you )?(making|earning)|sales target|paying clients)\b/i.test(draft);
}
