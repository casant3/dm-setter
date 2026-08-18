import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Reads the Trello screenshot corpus that ships as a set of numbered ZIP parts.
 *
 * The parts are a transport detail only: card identity comes from the Trello
 * shortLink embedded in each folder name, and screenshot identity comes from the
 * Trello attachment id in each filename. Part number says nothing about
 * chronology, and a card may legitimately appear in more than one part.
 */

export const EXPECTED_PARTS = 12;
export const EXPECTED_CARDS = 67;
export const EXPECTED_SCREENSHOTS = 360;

export type ScreenshotRef = {
  /** Trello attachment id, parsed from `photo__<id>.png`. The dedupe key. */
  attachment_id: string;
  /** Path inside the ZIP. */
  entry: string;
  zip: string;
  part: number;
  bytes: number;
};

export type CardRecord = {
  /** Trello shortLink, parsed from the `__<shortLink>` folder suffix. */
  short_link: string;
  folder: string;
  outcome: string;
  parts: number[];
  screenshots: ScreenshotRef[];
  metadata: CardMetadata | null;
};

export type CardMetadata = {
  id: string;
  name: string;
  shortLink: string;
  shortUrl?: string;
  url?: string;
  list: string;
  description?: string;
  dateLastActivity?: string;
  labels?: { name: string }[];
  members?: { fullName?: string }[];
  attachment_count?: number;
};

export type DatasetReport = {
  parts_present: number[];
  parts_missing: number[];
  cards: CardRecord[];
  total_screenshots: number;
  duplicate_attachments: { attachment_id: string; seen_in: string[] }[];
  cards_missing_metadata: string[];
  /** Card folders whose screenshot count disagrees with Trello's attachment_count. */
  count_mismatches: { short_link: string; expected: number; found: number }[];
  complete: boolean;
  problems: string[];
};

const ZIP_PATTERN = /trello_dataset_part_(\d{2})_of_(\d{2})\.zip$/;
/**
 * Screenshots keep their original filename with the Trello attachment id appended,
 * so the shapes vary wildly (`photo__<id>.png`, `IMG_4475__<id>.png`,
 * `WhatsApp_Image_...__<id>.jpeg`). The invariant is the hex id before the
 * extension — that, not the filename, is the identity.
 */
const PHOTO_PATTERN = /__([0-9a-f]{16,})\.(?:png|jpe?g|webp|heic)$/i;
const SHORTLINK_PATTERN = /__([A-Za-z0-9]{6,})$/;

export async function ensureUnzip(): Promise<void> {
  try {
    await exec("unzip", ["-v"]);
  } catch {
    throw new Error("`unzip` is required to read the dataset parts but was not found on PATH.");
  }
}

/** Finds dataset ZIPs in a directory, tolerating upload-id filename prefixes. */
export async function findParts(dir: string): Promise<{ part: number; file: string }[]> {
  const entries = await fs.readdir(dir);
  const found: { part: number; file: string }[] = [];
  for (const name of entries) {
    const m = ZIP_PATTERN.exec(name);
    if (!m) continue;
    found.push({ part: Number(m[1]), file: path.join(dir, name) });
  }
  return found.sort((a, b) => a.part - b.part);
}

type ZipEntry = { name: string; bytes: number };

async function listZip(file: string): Promise<ZipEntry[]> {
  const { stdout } = await exec("unzip", ["-l", file], { maxBuffer: 64 * 1024 * 1024 });
  const entries: ZipEntry[] = [];
  for (const line of stdout.split("\n")) {
    // "  901589  2026-08-18 20:15   folder/file.png"
    const m = /^\s*(\d+)\s+\S+\s+\S+\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[2];
    if (name === "Name" || name.endsWith("/")) continue;
    entries.push({ name, bytes: Number(m[1]) });
  }
  return entries;
}

export async function readZipFile(zip: string, entry: string): Promise<Buffer> {
  const { stdout } = await exec("unzip", ["-p", zip, entry], {
    maxBuffer: 128 * 1024 * 1024,
    encoding: "buffer",
  } as never);
  return stdout as unknown as Buffer;
}

async function readZipJson<T>(zip: string, entry: string): Promise<T | null> {
  try {
    const buf = await readZipFile(zip, entry);
    return JSON.parse(buf.toString("utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Scans every available part and assembles one logical dataset.
 *
 * Deduplication happens on (card shortLink, attachment id), so re-uploading a
 * part or overlapping parts cannot inflate the counts.
 */
export async function scanDataset(dir: string): Promise<DatasetReport> {
  await ensureUnzip();
  const parts = await findParts(dir);
  const partsPresent = parts.map((p) => p.part);
  const partsMissing = Array.from({ length: EXPECTED_PARTS }, (_, i) => i + 1).filter(
    (n) => !partsPresent.includes(n),
  );

  const byCard = new Map<string, CardRecord>();
  const attachmentSeen = new Map<string, string[]>();
  const problems: string[] = [];

  for (const { part, file } of parts) {
    const entries = await listZip(file);

    for (const entry of entries) {
      const segments = entry.name.split("/");
      if (segments.length < 2) continue; // _batch_manifest.json etc.

      const outcome = segments[0];
      const folder = segments[1];
      const leaf = segments[segments.length - 1];

      const linkMatch = SHORTLINK_PATTERN.exec(folder);
      if (!linkMatch) {
        problems.push(`Card folder without a Trello shortLink suffix: ${folder}`);
        continue;
      }
      const shortLink = linkMatch[1];

      let card = byCard.get(shortLink);
      if (!card) {
        card = { short_link: shortLink, folder, outcome, parts: [], screenshots: [], metadata: null };
        byCard.set(shortLink, card);
      }
      if (!card.parts.includes(part)) card.parts.push(part);
      if (card.outcome !== outcome) {
        problems.push(`Card ${shortLink} appears under two outcomes: ${card.outcome} and ${outcome}`);
      }

      if (leaf === "card_metadata.json") {
        if (!card.metadata) card.metadata = await readZipJson<CardMetadata>(file, entry.name);
        continue;
      }

      const photo = PHOTO_PATTERN.exec(leaf);
      if (!photo) continue;
      const attachmentId = photo[1];

      const seen = attachmentSeen.get(attachmentId) ?? [];
      seen.push(`part ${part}`);
      attachmentSeen.set(attachmentId, seen);

      // Dedupe: an attachment id already recorded for this card is the same image.
      if (card.screenshots.some((s) => s.attachment_id === attachmentId)) continue;
      card.screenshots.push({ attachment_id: attachmentId, entry: entry.name, zip: file, part, bytes: entry.bytes });
    }
  }

  const cards = [...byCard.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  const totalScreenshots = cards.reduce((n, c) => n + c.screenshots.length, 0);

  const duplicates = [...attachmentSeen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([attachment_id, seen_in]) => ({ attachment_id, seen_in }));

  const cardsMissingMetadata = cards.filter((c) => !c.metadata).map((c) => c.folder);

  const countMismatches = cards
    .filter((c) => c.metadata?.attachment_count != null && c.metadata.attachment_count !== c.screenshots.length)
    .map((c) => ({ short_link: c.short_link, expected: c.metadata!.attachment_count!, found: c.screenshots.length }));

  if (partsMissing.length > 0) problems.push(`Missing dataset parts: ${partsMissing.join(", ")}`);
  if (cards.length !== EXPECTED_CARDS) problems.push(`Expected ${EXPECTED_CARDS} cards, found ${cards.length}`);
  if (totalScreenshots !== EXPECTED_SCREENSHOTS) {
    problems.push(`Expected ${EXPECTED_SCREENSHOTS} screenshots, found ${totalScreenshots}`);
  }
  if (cardsMissingMetadata.length > 0) {
    problems.push(`${cardsMissingMetadata.length} card(s) have no card_metadata.json`);
  }

  return {
    parts_present: partsPresent,
    parts_missing: partsMissing,
    cards,
    total_screenshots: totalScreenshots,
    duplicate_attachments: duplicates,
    cards_missing_metadata: cardsMissingMetadata,
    count_mismatches: countMismatches,
    complete:
      partsMissing.length === 0 && cards.length === EXPECTED_CARDS && totalScreenshots === EXPECTED_SCREENSHOTS,
    problems,
  };
}

/**
 * Orders a card's screenshots.
 *
 * Trello attachment ids are prefixed with a hex timestamp, giving a stable upload
 * order that is far more reliable than filename or part number. Where that fails
 * the entry name is the tiebreak. This is upload order, not necessarily the order
 * the conversation happened in — human verification confirms the sequence.
 */
export function orderScreenshots(shots: ScreenshotRef[]): ScreenshotRef[] {
  return [...shots].sort((a, b) => {
    const ta = parseInt(a.attachment_id.slice(0, 8), 16);
    const tb = parseInt(b.attachment_id.slice(0, 8), 16);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return a.entry.localeCompare(b.entry);
  });
}

/** Pulls the Instagram handle out of a Trello card name such as `@handle 21/07/26`. */
export function handleFromCardName(name: string | undefined): string | null {
  if (!name) return null;
  // Trello inserts a zero-width joiner in some names; strip it before matching.
  const cleaned = name.replace(/‌|​/g, "");
  const m = /@([A-Za-z0-9._]{2,30})/.exec(cleaned);
  return m ? m[1] : null;
}

/** The setter who ran the conversation, from the card label or its creator. */
export function setterFromCard(meta: CardMetadata | null): string | null {
  const label = meta?.labels?.find((l) => l.name)?.name;
  if (label) return label;
  const member = meta?.members?.find((m) => m.fullName)?.fullName;
  return member ?? null;
}
