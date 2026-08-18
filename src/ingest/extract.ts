import fs from "node:fs/promises";
import { assessOutcome, promoteWithSignals, type OutcomeMove } from "@/core/outcomes";
import { handleFromCardName, orderScreenshots, setterFromCard, type CardRecord, type DatasetReport } from "@/ingest/dataset";
import type { OutcomeTier } from "@/lib/types";

/**
 * Turns the validated screenshot corpus plus the Trello board export into one
 * record per prospect conversation, ready for transcription.
 *
 * No transcript text is produced here. This stage establishes identity, outcome
 * and provenance only — everything it writes can be traced to the export.
 */

export type BoardExport = {
  cards: {
    id: string;
    name: string;
    shortLink: string;
    idList: string;
    desc?: string;
    closed?: boolean;
  }[];
  lists: { id: string; name: string }[];
  actions: {
    type: string;
    date: string;
    data: {
      card?: { id?: string; shortLink?: string; name?: string };
      listBefore?: { name: string };
      listAfter?: { name: string };
      text?: string;
    };
  }[];
};

export type ExtractedConversation = {
  external_card_id: string;
  short_link: string;
  instagram_handle: string | null;
  card_name: string;
  setter_name: string | null;
  outcome: string;
  outcome_tier: OutcomeTier;
  tier_rationale: string;
  booking_not_honoured: boolean;
  outcome_history: OutcomeMove[];
  comments: { text: string; at: string }[];
  notes: string | null;
  screenshots: { attachment_id: string; entry: string; zip: string; order: number }[];
  /** Follower count and role parsed out of the card description, when present. */
  profile_hints: { followers: number | null; descriptor: string | null };
};

export async function loadBoardExport(file: string): Promise<BoardExport> {
  return JSON.parse(await fs.readFile(file, "utf8")) as BoardExport;
}

/** Movement trail per card shortLink, oldest first. */
export function buildOutcomeHistory(board: BoardExport): Map<string, OutcomeMove[]> {
  const byCard = new Map<string, OutcomeMove[]>();
  const moves = board.actions
    .filter((a) => a.type === "updateCard" && a.data.listBefore && a.data.listAfter)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const action of moves) {
    const key = action.data.card?.shortLink;
    if (!key) continue;
    const list = byCard.get(key) ?? [];
    list.push({ from: action.data.listBefore!.name, to: action.data.listAfter!.name, at: action.date });
    byCard.set(key, list);
  }
  return byCard;
}

export function buildComments(board: BoardExport): Map<string, { text: string; at: string }[]> {
  const byCard = new Map<string, { text: string; at: string }[]>();
  for (const action of board.actions) {
    if (action.type !== "commentCard") continue;
    const key = action.data.card?.shortLink;
    const text = action.data.text;
    if (!key || !text) continue;
    const list = byCard.get(key) ?? [];
    list.push({ text, at: action.date });
    byCard.set(key, list);
  }
  return byCard;
}

/** "6.6k Followers, mortgage advisor & podcaster" → { followers: 6600, descriptor } */
export function parseProfileHints(desc: string | undefined): { followers: number | null; descriptor: string | null } {
  if (!desc?.trim()) return { followers: null, descriptor: null };
  const followerMatch = /(\d+(?:[.,]\d+)?)\s*([km])\b/i.exec(desc);
  let followers: number | null = null;
  if (followerMatch) {
    const n = Number(followerMatch[1].replace(",", "."));
    const unit = followerMatch[2].toLowerCase();
    followers = Math.round(n * (unit === "k" ? 1_000 : 1_000_000));
  }
  const descriptor = desc
    .split(/\n|\|/)
    .map((s) => s.trim())
    .filter((s) => s && !/^\d+(\.\d+)?[km]?\s*(followers)?$/i.test(s))
    .slice(0, 2)
    .join(" — ")
    .slice(0, 200);
  return { followers, descriptor: descriptor || null };
}

/**
 * Comment text sometimes records what happened after a call ("Great call. 2nd
 * call underway"), which is the only evidence that a Discovery actually
 * progressed. Used to promote Tier C to Tier B.
 */
export function signalsFromComments(comments: { text: string }[]): {
  showed?: boolean;
  progressed?: boolean;
  closed?: boolean;
} {
  const joined = comments.map((c) => c.text.toLowerCase()).join(" | ");
  return {
    showed: /\b(great|good|solid) call\b|\bcall (went|done)\b|\bspoke (with|to)\b/.test(joined),
    progressed: /\b2nd call\b|\bsecond call\b|\bunderway\b|\bproposal\b|\bnext step\b/.test(joined),
    closed: /\bsigned\b|\bclosed\b|\bonboarded\b|\bpaid\b/.test(joined),
  };
}

export function extractConversations(report: DatasetReport, board: BoardExport): ExtractedConversation[] {
  const history = buildOutcomeHistory(board);
  const comments = buildComments(board);
  const boardByLink = new Map(board.cards.map((c) => [c.shortLink, c]));

  return report.cards.map((card: CardRecord) => {
    const meta = card.metadata;
    const shortLink = card.short_link;
    const boardCard = boardByLink.get(shortLink);
    const moves = history.get(shortLink) ?? [];
    const cardComments = comments.get(shortLink) ?? [];

    const base = assessOutcome(card.outcome, moves);
    const assessment = promoteWithSignals(base, signalsFromComments(cardComments));

    const desc = meta?.description ?? boardCard?.desc;

    return {
      external_card_id: meta?.id ?? boardCard?.id ?? shortLink,
      short_link: shortLink,
      instagram_handle: handleFromCardName(meta?.name ?? boardCard?.name),
      card_name: meta?.name ?? boardCard?.name ?? card.folder,
      setter_name: setterFromCard(meta),
      outcome: card.outcome,
      outcome_tier: assessment.tier,
      tier_rationale: assessment.rationale,
      booking_not_honoured: assessment.booking_not_honoured,
      outcome_history: moves,
      comments: cardComments,
      notes: desc ?? null,
      screenshots: orderScreenshots(card.screenshots).map((s, i) => ({
        attachment_id: s.attachment_id,
        entry: s.entry,
        zip: s.zip,
        order: i,
      })),
      profile_hints: parseProfileHints(desc),
    };
  });
}
