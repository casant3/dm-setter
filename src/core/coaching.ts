import type { CoachingExample, SetterPreference } from "@/lib/types";

/**
 * How Cassey actually wants this written.
 *
 * The setter already learns strategy from historical winners and tone from
 * historical voice examples. Neither of those can carry an instruction — "stop
 * opening with 'quick one'", "never mention price before he does" — and neither
 * updates when the operator changes their mind.
 *
 * This layer carries those, in a strict precedence order, so that when two
 * sources disagree the setter knows which one wins. Nothing enters it
 * automatically: everything learned from live edits or imported from elsewhere
 * arrives as a proposal a human has to approve.
 */

export const COACHING_PRIORITY = [
  "explicit_rule",
  "approved_example",
  "approved_live_message",
  "historical_voice",
  "team_strategy",
  "generic_prompt",
] as const;
export type CoachingTier = (typeof COACHING_PRIORITY)[number];

export const TIER_LABELS: Record<CoachingTier, string> = {
  explicit_rule: "1. Explicit rule from Cassey — overrides everything below",
  approved_example: "2. Coaching example Cassey approved — follow its shape",
  approved_live_message: "3. Messages Cassey actually sent — the live voice",
  historical_voice: "4. Cassey's historical messages — tone reference",
  team_strategy: "5. Team strategy from winning conversations — approach, not wording",
  generic_prompt: "6. These general instructions — the fallback when nothing above applies",
};

export type ApprovedLiveMessage = {
  sent: string;
  stage: string | null;
  at: string;
  /** True when Cassey rewrote the suggestion rather than sending it as-is. */
  edited: boolean;
};

export type CoachingLayer = {
  rules: string[];
  examples: { situation: string; their_message: string | null; reply: string; why: string | null }[];
  live_messages: ApprovedLiveMessage[];
  precedence: string[];
  note: string;
};

/**
 * Assembles the coaching layer for the prompt.
 *
 * Only approved material is included. Pending proposals are deliberately absent:
 * a rule nobody has looked at yet must not change what the setter sends.
 */
export function buildCoachingLayer(input: {
  preferences: SetterPreference[];
  examples: CoachingExample[];
  liveMessages: ApprovedLiveMessage[];
  stage?: string | null;
}): CoachingLayer {
  const stage = input.stage?.toLowerCase() ?? null;

  const rules = input.preferences
    .filter((p) => p.status === "active")
    .filter((p) => !p.applies_to || !stage || p.applies_to.toLowerCase() === stage)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((p) => p.rule);

  const examples = input.examples
    .filter((e) => e.status === "approved")
    .slice(0, 6)
    .map((e) => ({
      situation: e.situation,
      their_message: e.prospect_message,
      reply: e.approved_reply,
      why: e.why,
    }));

  return {
    rules,
    examples,
    live_messages: input.liveMessages.slice(0, 8),
    precedence: COACHING_PRIORITY.map((t) => TIER_LABELS[t]),
    note: "When two sources conflict, the higher-numbered rule loses. An explicit rule from Cassey beats an example, an example beats a message she once sent, and all of them beat the general instructions.",
  };
}

// ---------------------------------------------------------------------------
// Learning from live edits
// ---------------------------------------------------------------------------

export type EditObservation = {
  /** What the diff appears to say about how Cassey wants it written. */
  proposed_rule: string;
  evidence: { suggested: string; sent: string };
  /** Always false on creation — a person approves it or it never applies. */
  auto_apply: false;
};

const CTA = /\b(call|\d{2} min\w*|jump on|hop on|(chat|speak|talk) (with|to) avo|book (a|in|some)|grab (a |some )?(time|\d{2}))/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function questions(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function openingOf(text: string): string {
  return text.trim().split(/[,.—-]/)[0].trim().toLowerCase();
}

/**
 * Reads one edit and proposes what it might mean.
 *
 * Deliberately conservative: it only proposes something when the change is
 * structural and unambiguous. A reworded sentence is not evidence of a rule, and
 * guessing at one from a single edit is how a setter acquires superstitions.
 */
export function observeEdit(suggested: string, sent: string): EditObservation[] {
  const out: EditObservation[] = [];
  const evidence = { suggested, sent };
  if (!suggested.trim() || !sent.trim() || suggested.trim() === sent.trim()) return out;

  const before = words(suggested);
  const after = words(sent);
  if (before - after >= 15 && after > 0) {
    out.push({
      proposed_rule: `Cut this shorter: ${before} words was rewritten to ${after}. Aim closer to ${after} words in this situation.`,
      evidence,
      auto_apply: false,
    });
  }

  if (questions(suggested) > questions(sent) && questions(sent) === 0) {
    out.push({
      proposed_rule: "Cassey removed the question entirely — in this situation she makes a statement and lets them come back.",
      evidence,
      auto_apply: false,
    });
  }

  if (CTA.test(suggested) && !CTA.test(sent)) {
    out.push({
      proposed_rule: "Cassey removed the call proposal — build more value here before suggesting a call.",
      evidence,
      auto_apply: false,
    });
  }

  if (!CTA.test(suggested) && CTA.test(sent)) {
    out.push({
      proposed_rule: "Cassey added the call proposal — this situation was ready for it and the draft was too passive.",
      evidence,
      auto_apply: false,
    });
  }

  const openingBefore = openingOf(suggested);
  const openingAfter = openingOf(sent);
  if (openingBefore && openingAfter && openingBefore !== openingAfter && openingBefore.length <= 40) {
    out.push({
      proposed_rule: `Cassey replaced the opening "${openingBefore}" with "${openingAfter}".`,
      evidence,
      auto_apply: false,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Importing coaching material from a ChatGPT export
// ---------------------------------------------------------------------------

type ChatGptMessage = { author?: { role?: string }; role?: string; content?: unknown };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("\n");
  if (content && typeof content === "object") {
    const c = content as { parts?: unknown[]; text?: unknown; content_type?: string };
    if (Array.isArray(c.parts)) return c.parts.map(contentText).join("\n");
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

export type ImportCandidate = {
  situation: string;
  prospect_message: string | null;
  approved_reply: string;
  why: string | null;
  source_title: string;
};

const DM_LIKE = /\b(dm|message|reply|respond|prospect|lead|setter|instagram)\b/i;

/**
 * Pulls candidate coaching examples out of a ChatGPT conversation export.
 *
 * Everything it returns is a *candidate*. The export contains drafts, rejected
 * ideas and half-finished thinking as well as messages Cassey stood behind, and
 * nothing in the file distinguishes them — so a person has to.
 */
export function parseChatGptExport(raw: unknown): ImportCandidate[] {
  const conversations = Array.isArray(raw) ? raw : [raw];
  const candidates: ImportCandidate[] = [];

  for (const conversation of conversations) {
    const c = conversation as { title?: string; mapping?: Record<string, { message?: ChatGptMessage }>; messages?: ChatGptMessage[] };
    const title = c?.title?.trim() || "Untitled conversation";

    const messages: ChatGptMessage[] = c?.mapping
      ? Object.values(c.mapping)
          .map((node) => node?.message)
          .filter((m): m is ChatGptMessage => Boolean(m))
      : (c?.messages ?? []);

    let lastUser = "";
    for (const message of messages) {
      const role = message.author?.role ?? message.role ?? "";
      const text = contentText(message.content).trim();
      if (!text) continue;

      if (role === "user") {
        lastUser = text;
        continue;
      }
      if (role !== "assistant") continue;
      if (!DM_LIKE.test(lastUser) && !DM_LIKE.test(title)) continue;
      // A DM, not an essay about DMs.
      if (words(text) > 90 || words(text) < 8) continue;

      candidates.push({
        situation: title,
        prospect_message: lastUser.slice(0, 500) || null,
        approved_reply: text.slice(0, 1000),
        why: null,
        source_title: title,
      });
    }
  }

  return candidates;
}
