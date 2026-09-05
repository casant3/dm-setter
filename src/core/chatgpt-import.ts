import {
  applyModelReading,
  readOperatorFeedback,
  type CoachingTag,
  type FeedbackKind,
  type FeedbackReading,
} from "@/core/operator-feedback";

/**
 * Importing coaching material from a ChatGPT export.
 *
 * Two things make the naive version wrong.
 *
 * First, an export is a *tree*, not a list. Regenerated answers and edited
 * prompts create siblings, and `Object.values(mapping)` returns them in whatever
 * order the file happens to hold — so a criticism can end up paired with a draft
 * the operator never saw. Paths are reconstructed from parent/child links, and
 * each branch is kept separate.
 *
 * Second, the assistant messages are not approved examples. Most of them are the
 * drafts that were rejected. The unit worth learning from is the whole chain:
 * draft → what the operator objected to → the next draft → what they objected to
 * next → eventually something they stood behind. Everything below is a
 * *candidate* awaiting human review.
 */

type ChatGptContent = { parts?: unknown[]; text?: unknown; content_type?: string };
type ChatGptAuthor = { role?: string };
export type ChatGptMessage = {
  id?: string;
  author?: ChatGptAuthor;
  role?: string;
  content?: unknown;
  create_time?: number | null;
  metadata?: Record<string, unknown> | null;
};

type MappingNode = {
  id?: string;
  message?: ChatGptMessage | null;
  parent?: string | null;
  children?: string[];
};

export type Conversation = {
  title?: string;
  create_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, MappingNode>;
  messages?: ChatGptMessage[];
};

export type Role = "user" | "assistant" | "system" | "tool";

export type Turn = {
  node_id: string;
  role: Role;
  text: string;
  create_time: number | null;
};

export type ConversationPath = {
  title: string;
  turns: Turn[];
  node_ids: string[];
  /** True for the path the export itself marks as current. */
  is_active: boolean;
  branch_index: number;
};

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("\n");
  if (content && typeof content === "object") {
    const c = content as ChatGptContent;
    if (Array.isArray(c.parts)) return c.parts.map(contentText).join("\n");
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

function roleOf(message: ChatGptMessage | null | undefined): Role | null {
  const role = message?.author?.role ?? message?.role;
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return null;
}

function hidden(message: ChatGptMessage | null | undefined): boolean {
  const meta = message?.metadata as Record<string, unknown> | undefined;
  return Boolean(meta?.is_visually_hidden_from_conversation);
}

/** Cap on branches per conversation, so a heavily regenerated thread cannot explode. */
const MAX_PATHS = 24;

/**
 * Rebuilds the conversational paths through an export.
 *
 * A path is root → leaf. Siblings are separate paths, because they are separate
 * conversations from the point they diverge: feedback given after one branch
 * says nothing about the other.
 */
export function reconstructPaths(conversation: Conversation): ConversationPath[] {
  const title = conversation?.title?.trim() || "Untitled conversation";

  // No tree: a plain message list is one linear path.
  if (!conversation?.mapping) {
    const turns: Turn[] = (conversation?.messages ?? [])
      .map((message, index) => {
        const role = roleOf(message);
        const text = contentText(message?.content).trim();
        if (!role || !text || hidden(message)) return null;
        return { node_id: message.id ?? `m${index}`, role, text, create_time: message.create_time ?? null };
      })
      .filter((t): t is Turn => t !== null);
    return turns.length ? [{ title, turns, node_ids: turns.map((t) => t.node_id), is_active: true, branch_index: 0 }] : [];
  }

  const mapping = conversation.mapping;
  const ids = Object.keys(mapping);

  const childrenOf = (id: string): string[] => {
    const declared = (mapping[id]?.children ?? []).filter((child) => Boolean(mapping[child]));
    // Fall back to parent links when `children` is absent or incomplete.
    const byParent = ids.filter((other) => mapping[other]?.parent === id);
    const all = [...new Set([...declared, ...byParent])];
    return all.sort((a, b) => {
      const at = mapping[a]?.message?.create_time ?? null;
      const bt = mapping[b]?.message?.create_time ?? null;
      if (at !== null && bt !== null && at !== bt) return at - bt;
      // Stable: fall back to the order the file declares.
      return declared.indexOf(a) - declared.indexOf(b);
    });
  };

  const roots = ids.filter((id) => {
    const parent = mapping[id]?.parent;
    return !parent || !mapping[parent];
  });

  // The path the export says is current, recovered by walking up from the leaf.
  const activeIds = new Set<string>();
  let cursor = conversation.current_node ?? null;
  const guard = new Set<string>();
  while (cursor && mapping[cursor] && !guard.has(cursor)) {
    guard.add(cursor);
    activeIds.add(cursor);
    cursor = mapping[cursor]?.parent ?? null;
  }

  const paths: string[][] = [];
  const walk = (id: string, trail: string[]) => {
    if (paths.length >= MAX_PATHS) return;
    const next = [...trail, id];
    const children = childrenOf(id);
    if (children.length === 0) {
      paths.push(next);
      return;
    }
    for (const child of children) walk(child, next);
  };
  for (const root of roots) walk(root, []);

  return paths
    .map((nodeIds, branchIndex) => {
      const turns: Turn[] = [];
      for (const nodeId of nodeIds) {
        const message = mapping[nodeId]?.message;
        const role = roleOf(message);
        const text = contentText(message?.content).trim();
        if (!role || role === "system" || role === "tool" || !text || hidden(message)) continue;
        turns.push({ node_id: nodeId, role, text, create_time: message?.create_time ?? null });
      }
      return {
        title,
        turns,
        node_ids: nodeIds,
        is_active: nodeIds.length > 0 && nodeIds.every((id) => activeIds.has(id)) && activeIds.size > 0,
        branch_index: branchIndex,
      };
    })
    .filter((path) => path.turns.length > 0);
}

// ---------------------------------------------------------------------------
// Correction chains
// ---------------------------------------------------------------------------

export const CANDIDATE_KINDS = ["good_example", "bad_example", "correction_pair", "correction_chain"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

export type Revision = {
  /** The draft as it was written. */
  reply: string;
  /** What the operator said about it, if anything. */
  feedback: string | null;
  tags: CoachingTag[];
};

export type CoachingCandidate = {
  kind: CandidateKind;
  /** Where this came from, for the reviewer. */
  situation: string;
  source_title: string;
  /** The prospect context in play, when the operator supplied any. */
  prospect_message: string | null;
  /** The draft that was rejected — present on everything except a good example. */
  rejected_reply: string | null;
  /** The operator's own words. */
  operator_feedback: string | null;
  /** Only ever set when the operator explicitly approved it. */
  approved_reply: string | null;
  /**
   * The draft that followed the criticism. Approved when `approved_reply` is
   * set; otherwise simply the next attempt, which nobody has blessed.
   */
  better_reply: string | null;
  /** Every draft in the chain, with the criticism that followed it. */
  revisions: Revision[];
  tags: CoachingTag[];
  /** Which branch this came from, so a reviewer can tell duplicates apart. */
  branch: { index: number; is_active: boolean };
  /** Messages whose meaning a model was asked about, or should be. */
  ambiguous_feedback: string[];
};

/** A DM, rather than an essay about DMs. */
const MIN_DRAFT_WORDS = 6;
const MAX_DRAFT_WORDS = 120;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeDraft(text: string): boolean {
  const words = wordCount(text);
  if (words < MIN_DRAFT_WORDS || words > MAX_DRAFT_WORDS) return false;
  // Numbered option lists and headed analyses are the model thinking aloud.
  if (/^(here (are|is)|option \d|version \d|\d\.\s)/i.test(text.trim())) return false;
  return true;
}

/** Where a model may be consulted about an ambiguous operator message. */
export type FeedbackClassifier = (text: string) => { kind: FeedbackKind; tags: string[] } | null;

function readingFor(text: string, classifier?: FeedbackClassifier): FeedbackReading {
  const deterministic = readOperatorFeedback(text);
  if (!deterministic.needs_model_judgement || !classifier) return deterministic;
  return applyModelReading(deterministic, classifier(text));
}

/**
 * Walks one path and pulls out every correction chain in it.
 *
 * Feedback always belongs to the draft immediately before it *on this path*, so
 * a criticism written after a regenerated answer cannot be attached to the
 * answer it replaced.
 */
export function extractCandidatesFromPath(path: ConversationPath, classifier?: FeedbackClassifier): CoachingCandidate[] {
  const candidates: CoachingCandidate[] = [];

  let prospectContext: string | null = null;
  let revisions: Revision[] = [];
  const ambiguous: string[] = [];
  /** Whether the turn before this one was a draft awaiting a verdict. */
  let previousWasDraft = false;

  const flush = (approved: string | null) => {
    if (revisions.length === 0) {
      if (!approved) return;
      candidates.push(makeCandidate("good_example", path, prospectContext, [], approved, ambiguous.splice(0)));
      return;
    }
    // How many drafts the operator actually criticised decides the shape. A
    // final uncriticised draft is the "better" attempt, not another rejection.
    const criticised = revisions.filter((r) => r.feedback).length;
    const hasBetter = approved !== null || revisions.length > criticised;
    const kind: CandidateKind =
      criticised >= 2 ? "correction_chain" : hasBetter ? "correction_pair" : "bad_example";
    candidates.push(makeCandidate(kind, path, prospectContext, revisions, approved, ambiguous.splice(0)));
    revisions = [];
  };

  for (let i = 0; i < path.turns.length; i += 1) {
    const turn = path.turns[i];

    if (turn.role === "user") {
      const reading = readingFor(turn.text, classifier);
      if (previousWasDraft && reading.needs_model_judgement) ambiguous.push(turn.text);
      // A user message that is not a verdict on a draft is new context: it ends
      // whatever chain was open, because the next draft answers a new brief.
      // "Rewrite it" only means rejection when there is something to reject —
      // the opening instruction of a conversation is a brief, not a criticism.
      const isVerdict =
        previousWasDraft && (reading.kind === "criticism" || reading.kind === "approval" || reading.kind === "instruction");
      if (!isVerdict) {
        flush(null);
        prospectContext = turn.text.slice(0, 800);
      }
      previousWasDraft = false;
      continue;
    }

    if (turn.role !== "assistant") continue;
    if (!looksLikeDraft(turn.text)) {
      previousWasDraft = false;
      continue;
    }
    previousWasDraft = true;

    // What did the operator say about this draft?
    const next = path.turns[i + 1];
    const reading = next && next.role === "user" ? readingFor(next.text, classifier) : null;

    if (reading?.kind === "approval") {
      flush(turn.text);
      continue;
    }
    if (reading?.kind === "criticism") {
      revisions.push({ reply: turn.text, feedback: reading.quote, tags: reading.tags });
      continue;
    }
    // An instruction ("try again", "rewrite it") is a rejection without a
    // reason: the draft was not accepted, but nothing was said about why.
    if (reading?.kind === "instruction") {
      revisions.push({ reply: turn.text, feedback: reading.quote, tags: [] });
      continue;
    }
    // Nothing was said about this draft. An unremarked draft is NOT approved —
    // silence in an export means the thread moved on, not that it was good.
    if (revisions.length > 0) {
      revisions.push({ reply: turn.text, feedback: null, tags: [] });
    }
  }

  flush(null);
  return candidates;
}

function makeCandidate(
  kind: CandidateKind,
  path: ConversationPath,
  prospectContext: string | null,
  revisions: Revision[],
  approved: string | null,
  ambiguous: string[],
): CoachingCandidate {
  const tags = [...new Set(revisions.flatMap((r) => r.tags))];
  const first = revisions[0] ?? null;
  const lastCriticised = [...revisions].reverse().find((r) => r.feedback) ?? first;
  const trailing = revisions.length > 0 && !revisions[revisions.length - 1].feedback ? revisions[revisions.length - 1].reply : null;

  return {
    kind,
    situation: path.title,
    source_title: path.title,
    prospect_message: prospectContext,
    rejected_reply: first?.reply ?? null,
    operator_feedback: lastCriticised?.feedback ?? null,
    approved_reply: approved,
    better_reply: approved ?? trailing,
    revisions,
    tags,
    branch: { index: path.branch_index, is_active: path.is_active },
    ambiguous_feedback: ambiguous,
  };
}

/**
 * Parses a whole export.
 *
 * Accepts the array of conversations ChatGPT produces, or a single conversation.
 */
export function parseChatGptExport(raw: unknown, classifier?: FeedbackClassifier): CoachingCandidate[] {
  const conversations = (Array.isArray(raw) ? raw : [raw]) as Conversation[];
  const out: CoachingCandidate[] = [];

  for (const conversation of conversations) {
    if (!conversation || typeof conversation !== "object") continue;
    for (const path of reconstructPaths(conversation)) {
      out.push(...extractCandidatesFromPath(path, classifier));
    }
  }

  return dedupe(out);
}

/**
 * Removes candidates that are the same material seen down two branches.
 *
 * Branches share their common prefix, so a chain that ended before the first
 * divergence appears once per leaf.
 */
function dedupe(candidates: CoachingCandidate[]): CoachingCandidate[] {
  const seen = new Map<string, CoachingCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.kind,
      candidate.rejected_reply ?? "",
      candidate.operator_feedback ?? "",
      candidate.approved_reply ?? "",
      candidate.revisions.map((r) => r.reply).join("|"),
    ].join("::");
    const existing = seen.get(key);
    // Prefer the copy from the active branch: it is the one the operator kept.
    if (!existing || (!existing.branch.is_active && candidate.branch.is_active)) seen.set(key, candidate);
  }
  return [...seen.values()];
}

/** A one-line description of what a candidate is, for the review queue. */
export function describeCandidate(candidate: CoachingCandidate): string {
  switch (candidate.kind) {
    case "good_example":
      return "A reply the operator explicitly approved.";
    case "bad_example":
      return `A rejected draft: ${candidate.operator_feedback ?? "no reason given"}`;
    case "correction_pair":
      return `One correction: ${candidate.operator_feedback ?? "no reason given"}`;
    case "correction_chain":
      return `${candidate.revisions.length} drafts, corrected each time${candidate.approved_reply ? ", then approved" : ""}.`;
  }
}
