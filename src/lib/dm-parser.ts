import type { Sender } from "@/lib/types";

export type ParsedMessage = {
  sender: Sender;
  message_text: string;
  /** The speaker label as written in the pasted text, so the UI can show what it matched. */
  label: string;
  sent_at: string | null;
};

export type ParseResult = {
  messages: ParsedMessage[];
  /** Labels the parser could not confidently assign; the UI asks the user to map these. */
  unknownLabels: string[];
  warnings: string[];
};

export type ParseOptions = {
  /** Handle/name of the prospect, used to recognise their speaker label. */
  prospectAliases?: string[];
  setterAliases?: string[];
  /** Assigned to messages with no timestamp, oldest first. */
  fallbackDate?: Date;
};

const DEFAULT_SETTER_ALIASES = ["me", "you", "cassey", "setter", "us", "we", "avo", "you sent"];
const DEFAULT_PROSPECT_ALIASES = ["them", "they", "prospect", "lead", "him", "her", "client"];

// "Label: message", allowing a leading timestamp such as "[10:32]" or "10:32 AM -".
const LINE_RE = /^\s*(?:\[([^\]]{1,40})\]\s*)?(?:(\d{1,2}:\d{2}(?:\s*[AaPp][Mm])?)\s*[-–—]?\s*)?@?([A-Za-z0-9._\- ]{1,40}?)\s*:\s*(.*)$/;

function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " ");
}

/** Instagram exports mark the user's own messages with a bare "You sent" line. */
const YOU_SENT_RE = /^\s*you sent\s*$/i;

function classify(label: string, setter: Set<string>, prospect: Set<string>): Sender | null {
  const n = normalize(label);
  if (setter.has(n)) return "setter";
  if (prospect.has(n)) return "prospect";
  return null;
}

/**
 * Parses a pasted Instagram DM thread into ordered messages.
 *
 * Handles "Me: / Them:" style, "@handle: " style, optional leading timestamps,
 * Instagram's "You sent" marker, and wrapped lines that continue the previous message.
 */
export function parseDmTranscript(raw: string, options: ParseOptions = {}): ParseResult {
  const setter = new Set([...DEFAULT_SETTER_ALIASES, ...(options.setterAliases ?? [])].map(normalize));
  const prospect = new Set([...DEFAULT_PROSPECT_ALIASES, ...(options.prospectAliases ?? [])].map(normalize));

  const messages: ParsedMessage[] = [];
  const unknown = new Set<string>();
  const warnings: string[] = [];
  let current: ParsedMessage | null = null;
  let pendingSender: Sender | null = null;

  const flush = () => {
    if (current && current.message_text.trim()) messages.push(current);
    current = null;
  };

  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }

    // A line that is nothing but a known speaker name marks who says the lines
    // that follow — the shape Instagram's own export uses.
    if (YOU_SENT_RE.test(line)) {
      flush();
      pendingSender = "setter";
      continue;
    }
    if (!line.includes(":")) {
      const bare = classify(line, setter, prospect);
      if (bare) {
        flush();
        pendingSender = bare;
        continue;
      }
    }

    const match = LINE_RE.exec(line);
    // A colon deep inside a sentence is prose, not a speaker label.
    const looksLikeLabel = match !== null && match[3].trim().length > 0 && !/[.!?]/.test(match[3]);

    if (looksLikeLabel && match) {
      const [, bracket, clock, label, text] = match;
      const sender = classify(label, setter, prospect);
      if (sender === null) unknown.add(label.trim());
      flush();
      current = {
        sender: sender ?? "prospect",
        message_text: text.trim(),
        label: label.trim(),
        sent_at: parseTimestamp(bracket ?? clock ?? null),
      };
      pendingSender = null;
      continue;
    }

    if (current) {
      current.message_text += `\n${line.trim()}`;
      continue;
    }

    // No label yet: either follows a "You sent" marker, or the paste has no labels at all.
    current = {
      sender: pendingSender ?? "prospect",
      message_text: line.trim(),
      label: pendingSender === "setter" ? "You sent" : "",
      sent_at: null,
    };
    pendingSender = null;
  }
  flush();

  if (messages.length === 0) warnings.push("No messages found in the pasted text.");
  if (unknown.size > 0) {
    warnings.push(
      `Unrecognised speaker labels: ${[...unknown].join(", ")}. They were treated as the prospect — map them before importing if that is wrong.`,
    );
  }
  if (messages.length > 0 && messages.every((m) => m.label === "")) {
    warnings.push("No speaker labels were found, so every line was treated as a prospect message.");
  }

  return { messages, unknownLabels: [...unknown], warnings };
}

/**
 * Timestamps in a pasted thread are usually partial ("10:32", "Mon 4:15 PM"), so
 * only fully parseable values are kept; the rest get sequenced at import time.
 */
function parseTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Assigns increasing timestamps to parsed messages, preserving any that were
 * explicitly parsed, so imported threads sort correctly against live messages.
 */
export function sequenceTimestamps(messages: ParsedMessage[], endingAt = new Date()): ParsedMessage[] {
  const stepMs = 60_000;
  const total = messages.length;
  return messages.map((m, i) => ({
    ...m,
    sent_at: m.sent_at ?? new Date(endingAt.getTime() - (total - 1 - i) * stepMs).toISOString(),
  }));
}
