import playbook from "../../config/playbook.json";
import type { LeadContext } from "@/core/context";
import type { SetterLlm } from "@/core/llm";
import type { Qualification, Review, Strategy } from "@/lib/types";

/**
 * Deterministic fallback setter used when OPENAI_API_KEY is absent.
 *
 * It applies the same qualification model, the same call gate and the same
 * SERVICE_CONFUSION rules as the prompt, so the pipeline, the UI and the tests
 * behave correctly without a live model. Its prose is intentionally plain —
 * this is a development stand-in, not a replacement for GPT-5.6.
 */

const CONFUSION_TRIGGERS: string[] = playbook.service_confusion_triggers;

const EXTRA_CONFUSION_PATTERNS = [
  /\bwhat (show|podcast) is this\b/i,
  /\b(be|being) a guest\b/i,
  /\bguest (spot|slot|appearance|invite|invitation)\b/i,
  /\bpodcast (invite|invitation)\b/i,
  /\binvit(e|ing) me\b/i,
  /\bcome on (the|your) (show|pod|podcast)\b/i,
  /\bfree\b.*\b(collab|feature|interview)\b/i,
  /\bdon'?t pay to (be on|appear)\b/i,
  /\bis this a (collab|partnership|podcast)\b/i,
];

const VALUE_WORDS = [
  "credibility", "authority", "search", "seo", "syndication", "written media",
  "positioning", "diligence", "third-party", "press", "coverage",
];

function lower(s: string | null | undefined): string {
  return (s ?? "").toLowerCase();
}

export function detectServiceConfusion(text: string): string | null {
  const t = lower(text);
  for (const trigger of CONFUSION_TRIGGERS) {
    if (t.includes(trigger.toLowerCase())) return `Prospect said something matching "${trigger}".`;
  }
  for (const re of EXTRA_CONFUSION_PATTERNS) {
    if (re.test(text)) return `Prospect's wording suggests they think this is a guest invitation or free collaboration.`;
  }
  return null;
}

function scoreQualification(ctx: LeadContext, confused: boolean): Qualification {
  const lead = ctx.lead;
  const memory = ctx.memory;

  const fit = lead.industry && lead.niche ? 2 : lead.industry || lead.niche ? 1 : 0;

  const goalsKnown = (memory?.goals?.length ?? 0) > 0;
  const commercial_goal = lead.commercial_goal && goalsKnown ? 2 : lead.commercial_goal || goalsKnown ? 1 : 0;

  const painKnown = (memory?.pain_points?.length ?? 0) > 0;
  const media_gap = lead.media_gap && painKnown ? 2 : lead.media_gap || painKnown ? 1 : 0;

  const setterText = ctx.recentMessages
    .filter((m) => m.sender === "setter")
    .map((m) => lower(m.message_text))
    .join(" ");
  const valueHits = VALUE_WORDS.filter((w) => setterText.includes(w)).length;
  const value_established = valueHits >= 3 ? 2 : valueHits >= 1 ? 1 : 0;

  const service_understanding = confused ? 0 : Math.max(0, Math.min(2, memory?.service_understanding ?? 0));

  const buying = ctx.recentMessages.some((m) => m.sender === "prospect" && m.is_buying_signal);
  const interest = lower(lead.interest_level);
  const interest_signal = buying || interest === "hot" ? 2 : interest === "warm" || ctx.recentMessages.some((m) => m.sender === "prospect") ? 1 : 0;

  return { fit, commercial_goal, media_gap, value_established, service_understanding, interest_signal };
}

function pickObjective(q: Qualification, confused: boolean): { stage: string; objective: string; strategy: string } {
  if (confused) {
    return {
      stage: "SERVICE_CONFUSION",
      objective: "Correct the premise: this is a professional media and authority service, not a guest invitation.",
      strategy:
        "Do not answer the surface question about episode length or show name. Correct the assumption plainly, without apologising or over-explaining, then re-anchor on the commercial goal already on the table.",
    };
  }
  if (q.commercial_goal === 0) {
    return {
      stage: "DISCOVERY",
      objective: "Establish what they are actually growing, launching, selling or trying to be known for.",
      strategy: "Ask one specific question about the commercial goal. Do not pitch and do not mention a call.",
    };
  }
  if (q.media_gap === 0) {
    return {
      stage: "DISCOVERY",
      objective: "Surface the real media/authority gap in their own words.",
      strategy: "Ask what currently comes up when someone looks them up. Let them state the gap themselves.",
    };
  }
  if (q.value_established < 2) {
    return {
      stage: "VALUE_BUILDING",
      objective: "Link media and authority specifically to their stated goal.",
      strategy:
        "Connect written media, third-party credibility and search presence to the outcome they named. Be specific to their situation, not generic exposure talk.",
    };
  }
  if (q.service_understanding < 1) {
    return {
      stage: "VALUE_BUILDING",
      objective: "Make the commercial model clear before any call is proposed.",
      strategy: "Convey naturally that this is something clients work with us on, without a blunt price announcement.",
    };
  }
  return {
    stage: "CALL_READY",
    objective: "Move to a call with Avo now that the goal, gap, value and model are all established.",
    strategy: "Make the next step easy and specific. Avo handles pricing and the discovery conversation.",
  };
}

function lastProspectMessage(ctx: LeadContext): string {
  const fromHistory = [...ctx.recentMessages].reverse().find((m) => m.sender === "prospect");
  return ctx.newMessage?.trim() || fromHistory?.message_text || "";
}

function buildStrategy(ctx: LeadContext): Strategy {
  const latest = lastProspectMessage(ctx);
  const confusionReason = detectServiceConfusion(latest);
  const confused = confusionReason !== null;
  const q = scoreQualification(ctx, confused);
  const total = Object.values(q).reduce((a, b) => a + b, 0);
  const { stage, objective, strategy } = pickObjective(q, confused);

  const missing: string[] = [];
  if (q.commercial_goal < 2) missing.push("A concrete commercial or authority goal in their own words");
  if (q.media_gap < 2) missing.push("A specific media/authority gap they acknowledge");
  if (q.value_established < 2) missing.push("Value tied to that goal rather than generic exposure");
  if (q.service_understanding < 2) missing.push("Clear understanding that this is a paid professional service");

  return {
    stage,
    qualification: q,
    total_score: total,
    call_ready: !confused && total >= 9 && q.fit > 0 && q.commercial_goal > 0 && q.service_understanding > 0,
    service_confusion: confused,
    confusion_reason: confusionReason,
    next_objective: objective,
    strategy,
    missing_information: missing,
    credibility_needed: q.value_established < 2 && ctx.credibility.length > 0,
    credibility_reason: q.value_established < 2 ? "Value is still abstract; approved proof would make it concrete." : null,
    should_explain_service: confused || q.service_understanding < 1,
  };
}

function firstName(ctx: LeadContext): string {
  const name = ctx.lead.name?.trim();
  if (name) return name.split(/\s+/)[0];
  return `@${ctx.lead.instagram_handle}`;
}

function buildReply(ctx: LeadContext, strategy: Strategy): string {
  const who = firstName(ctx);
  const goal = ctx.lead.commercial_goal;
  const gap = ctx.lead.media_gap;

  if (strategy.service_confusion) {
    const anchor = goal ? ` Given ${lower(goal)}, that's the part that actually matters.` : "";
    return `Ah — I should be clearer, this isn't me inviting you on as a guest. We work with clients on building out media and authority: podcast placement, written media, and the search presence that sits behind it.${anchor} Want me to walk you through what that would look like in your case?`;
  }
  if (strategy.qualification.commercial_goal === 0) {
    return `Quick one ${who} — what are you actually building toward over the next few months? Launching something, raising, or trying to get known for a specific thing?`;
  }
  if (strategy.qualification.media_gap === 0) {
    return `Makes sense. When someone hears about you and looks you up, what actually comes up right now?`;
  }
  if (strategy.qualification.value_established < 2) {
    const g = goal ? lower(goal) : "what you're building";
    const gp = gap ? ` Right now ${lower(gap)}, which is the gap.` : "";
    return `That's the piece most people underrate. For ${g}, the thing that moves the needle isn't more reach — it's third-party credibility and search presence, so that when someone checks you out there's something other than your own feed vouching for you.${gp}`;
  }
  if (strategy.qualification.service_understanding < 1) {
    return `Worth saying how this works on our side — this is what we do for clients: we handle the placement across podcasts and written media and position it around what you're actually selling. Happy to show you what that looks like specifically for you.`;
  }
  return `I think this is worth a proper conversation. Avo directs this side and handles the specifics — would it be easier to grab 20 minutes with him this week or next?`;
}

/** Mirrors the reviewer pass: catch the common failure modes, rewrite if needed. */
function buildReview(ctx: LeadContext, strategy: Strategy, draft: string): Review {
  const issues: string[] = [];
  let final = draft.trim();

  const asked = (ctx.memory?.questions_already_asked ?? []).map((q) => lower(String(q)));
  const draftLower = lower(final);
  if (asked.some((q) => q.length > 12 && draftLower.includes(q.replace(/\?$/, "").slice(0, 20)))) {
    issues.push("Repeats a question already asked in this conversation.");
  }

  const mentionsCall = /\b(call|chat|20 minutes|avo)\b/i.test(final);
  if (mentionsCall && !strategy.call_ready) {
    issues.push("Proposes a call before the hard gate is met.");
    final = buildReply(ctx, { ...strategy, qualification: { ...strategy.qualification, service_understanding: 0 } });
  }

  if (strategy.service_confusion && !/isn'?t me inviting|not a guest|work with clients/i.test(final)) {
    issues.push("Service confusion is unresolved in the draft.");
    final = buildReply(ctx, strategy);
  }

  if (final.length > 700) {
    issues.push("Too long for an Instagram DM.");
    final = `${final.slice(0, 680).trimEnd()}…`;
  }

  return { approved: issues.length === 0, issues, final_reply: final };
}

export const offlineLlm: SetterLlm = {
  engine: "offline",
  async strategy(ctx) {
    return buildStrategy(ctx);
  },
  async reply(ctx, _context, strategy) {
    return buildReply(ctx, strategy);
  },
  async review(ctx, _context, strategy, draft) {
    return buildReview(ctx, strategy, draft);
  },
};
