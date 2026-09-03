/**
 * Reading the lead vault.
 *
 * The daily lead list lives in a hand-maintained Google Sheet, and it is not a
 * table of records: it is a grid. Each row is a day, each column after the first
 * is one lead, and the sheet carries block labels ("SuccessfulArcs"), quarter
 * markers ("Q3"), status headers ("SENT", "OPENED", "WARM"), running totals
 * ("TOTAL WARM = 26") and empty rows waiting to be filled in.
 *
 * Handles are written by hand, so they arrive with stray spaces, a leading @,
 * trailing dates ("kb_the_rockstar_ceo - founder 29/07"), role annotations
 * ("st_snyder - business owner") and the occasional note that is not a handle at
 * all ("all warm leads on trello", "martinvars ( private Instagram account and
 * can not message)").
 *
 * Nothing here writes anything. It reads the grid into candidates a person
 * confirms, because a parser that silently creates prospects from a spreadsheet
 * someone is still editing is a parser that fills the inbox with rubbish.
 */

export type LeadCandidate = {
  instagram_handle: string;
  /** The day's row this came from, as written. */
  source_date: string | null;
  /** ISO date, where the row's date could be understood. */
  dated_at: string | null;
  /** The role or note written beside the handle, if any. */
  note: string | null;
  /** The block label above this row — usually the sending page. */
  block: string | null;
  /** Column index, 1-based, as it appears in the day's row. */
  position: number;
  /** The cell exactly as written, so a reviewer can check the parse. */
  raw: string;
};

export type SheetParseResult = {
  candidates: LeadCandidate[];
  /** Cells that looked like data but could not be read as a handle. */
  skipped: { raw: string; reason: string; source_date: string | null }[];
  /** Block labels found, in order — the sending pages, where the sheet says. */
  blocks: string[];
  /** Days that had at least one lead. */
  days: number;
  /** Rows that exist but are still empty, i.e. days not yet filled in. */
  empty_days: number;
};

/** Row labels that are structure rather than a day of leads. */
const STRUCTURAL = [
  /^date$/i,
  /^ig handle$/i,
  /^:-:$/,
  /^sent$/i,
  /^opened$/i,
  /^warm$/i,
  /^info packet sent$/i,
  /^discovery call booked$/i,
  /^miscellaneous$/i,
  /^total\b/i,
  /^q[1-4]$/i,
  /^\d+$/,
  /^\[merged\]/i,
];

/** A row label that names the page a block was sent from. */
const BLOCK_LABEL = /^[A-Za-z][A-Za-z0-9._\s/&-]{2,40}$/;

type DateParser = { re: RegExp; parse: (m: RegExpMatchArray, year: number) => string | null };

const DATE_PATTERNS: DateParser[] = [
  // 03/09/2026, 3/9/26, 03.09.2026
  {
    re: /^(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{2,4})$/,
    parse: (m) => {
      const [, d, mo, y] = m;
      const year = y.length === 2 ? 2000 + Number(y) : Number(y);
      return isoDate(year, Number(mo), Number(d));
    },
  },
  // 26/8, 27.8 — a day and a month with the year left off, which is how the
  // sheet is written by hand once the year is obvious from the tab. Day-first,
  // the same reading as the three-part form above; without this the row is not
  // a day row at all and its whole line of handles is dropped in silence.
  {
    re: /^(\d{1,2})\s*[/.]\s*(\d{1,2})$/,
    parse: (m, year) => isoDate(year, Number(m[2]), Number(m[1])),
  },
  // "3rd September", "22nd of July", "1th of August"
  {
    re: /^(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([A-Za-z]+)/i,
    parse: (m, year) => {
      const month = MONTHS.findIndex((name) => name.startsWith(m[2].slice(0, 3).toLowerCase()));
      if (month === -1) return null;
      // These rows name a month but no year, so the caller supplies one.
      return isoDate(year, month + 1, Number(m[1]));
    },
  },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString();
}

/**
 * True when the first cell of a row names a day.
 *
 * `year` is used only by rows that give a month without one ("22nd of July").
 */
export function parseRowDate(label: string, year = new Date().getUTCFullYear()): string | null {
  const text = label.trim().replace(/\s+/g, " ");
  for (const { re, parse } of DATE_PATTERNS) {
    const m = text.match(re);
    if (m) return parse(m, year);
  }
  return null;
}

/**
 * Splits one cell into a handle and whatever was written beside it.
 *
 * Instagram handles are letters, digits, dots and underscores, up to 30
 * characters. Anything else in the cell is a note: a role, a date the operator
 * jotted down, or a remark about the account.
 */
export function parseCell(raw: string): { handle: string; note: string | null } | { reason: string } {
  const text = raw
    .replace(/&#13;/g, " ")
    .replace(/\\/g, "")
    .trim();
  if (!text) return { reason: "empty" };

  const words = text.split(/\s+/);
  const firstToken = words[0].replace(/^@/, "").replace(/[,;]+$/, "");

  if (!/^[A-Za-z0-9._]{1,30}$/.test(firstToken)) {
    return { reason: `"${text.slice(0, 40)}" does not start with a handle` };
  }
  // A handle has to contain a letter; a bare number is a column index.
  if (!/[A-Za-z]/.test(firstToken)) return { reason: `"${text.slice(0, 40)}" is not a handle` };

  const rest = text.slice(text.indexOf(words[0]) + words[0].length).trim();

  // Telling "st_snyder - business owner" from "all warm leads on trello".
  //
  // A note is introduced by punctuation, or the first word is visibly a handle
  // rather than an English word — a dot, an underscore or a digit in it. Prose
  // with neither is a remark the operator wrote to themselves, and importing
  // its first word as a prospect would create a lead called "all".
  const handleShaped = /[._\d]/.test(firstToken);
  const noteIntroduced = /^[-–—,(:]/.test(rest);
  if (rest && !noteIntroduced && !handleShaped) {
    return { reason: `"${text.slice(0, 40)}" reads as a note rather than a handle` };
  }

  const note = rest.replace(/^[-–—,(:]\s*/, "").replace(/\)$/, "").trim();

  return { handle: firstToken.toLowerCase(), note: note || null };
}

/** Parses delimited text — CSV from a Sheets export, or TSV pasted from the browser. */
export function parseDelimited(text: string): string[][] {
  const rows: string[][] = [];
  const delimiter = detectDelimiter(text);
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows.filter((r) => r.length > 0);
}

function detectDelimiter(text: string): string {
  const sample = text.split("\n").slice(0, 20).join("\n");
  const tabs = (sample.match(/\t/g) ?? []).length;
  const commas = (sample.match(/,/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/**
 * Reads the grid.
 *
 * Rows whose first cell names a day become leads; rows whose first cell is a
 * plain label become the block those days belong to, which is how the sheet
 * records the page a batch was sent from.
 */
export function parseLeadSheet(rows: string[][], options: { year?: number } = {}): SheetParseResult {
  const year = options.year ?? new Date().getUTCFullYear();
  const candidates: LeadCandidate[] = [];
  const skipped: SheetParseResult["skipped"] = [];
  const blocks: string[] = [];
  let block: string | null = null;
  let days = 0;
  let emptyDays = 0;

  for (const row of rows) {
    if (row.length === 0) continue;
    const label = (row[0] ?? "").replace(/\\/g, "").trim();
    const rest = row.slice(1).filter((c) => c.trim());

    const dated = parseRowDate(label, year);
    if (!dated) {
      // Not a day. It may be the label naming the page for the rows below.
      if (label && !STRUCTURAL.some((re) => re.test(label)) && BLOCK_LABEL.test(label) && rest.length === 0) {
        block = label;
        if (!blocks.includes(label)) blocks.push(label);
      }
      continue;
    }

    if (rest.length === 0) {
      // A dated row with nothing in it: a day the sheet is waiting to fill.
      emptyDays += 1;
      continue;
    }
    days += 1;

    row.slice(1).forEach((raw, index) => {
      if (!raw.trim()) return;
      const parsed = parseCell(raw);
      if ("reason" in parsed) {
        skipped.push({ raw: raw.trim().slice(0, 120), reason: parsed.reason, source_date: label });
        return;
      }
      candidates.push({
        instagram_handle: parsed.handle,
        source_date: label,
        dated_at: dated,
        note: parsed.note,
        block,
        position: index + 1,
        raw: raw.trim().slice(0, 120),
      });
    });
  }

  return { candidates, skipped, blocks, days, empty_days: emptyDays };
}

/**
 * Removes handles seen earlier in the same sheet.
 *
 * The grid repeats a prospect when they move between status columns, and the
 * first appearance is the one with the real date on it.
 */
export function dedupeCandidates(candidates: LeadCandidate[]): {
  unique: LeadCandidate[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const unique: LeadCandidate[] = [];
  let duplicates = 0;

  for (const candidate of candidates) {
    if (seen.has(candidate.instagram_handle)) {
      duplicates += 1;
      continue;
    }
    seen.add(candidate.instagram_handle);
    unique.push(candidate);
  }
  return { unique, duplicates };
}
