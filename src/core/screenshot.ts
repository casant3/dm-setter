import type { Message, Sender } from "@/lib/types";

/**
 * Reading a screenshot of a conversation.
 *
 * On a phone, retyping or copy-pasting a thread message by message is the
 * slowest part of the loop. A screenshot of the Instagram conversation carries
 * the whole exchange, and a vision model can read it.
 *
 * What it must never do is guess. A transcript that invents a line the prospect
 * did not write poisons everything downstream — the dialogue ledger, the
 * qualification evidence, the memory — so unreadable spans are marked as
 * unreadable, every line comes back for review, and nothing reaches the thread
 * until a person has confirmed it.
 */

export type ScreenshotLine = {
  sender: Sender;
  text: string;
  /** The model's own confidence that it read this line correctly. */
  confidence: "high" | "low";
  /** True when part of the line was cut off or illegible. */
  partial: boolean;
};

export type ScreenshotReading = {
  lines: ScreenshotLine[];
  /** Anything the model could not read at all, described rather than invented. */
  unreadable: string[];
  /** Whether the image looked like a DM conversation in the first place. */
  looks_like_conversation: boolean;
  notes: string | null;
};

export const SCREENSHOT_INSTRUCTIONS = `Read this screenshot of an Instagram DM conversation and transcribe it exactly.

Rules:
- Transcribe only what is visibly written. Never complete a sentence that is cut off, and never infer what someone "would have" said.
- Mark a line "partial" when it is clipped by the edge of the screen or hidden behind the interface.
- Mark a line "low" confidence when the text is blurred, small, or you are unsure of a word.
- Anything you cannot read at all goes in "unreadable" as a short description of where it is, not as a guess at its content.
- Identify who sent each message from the layout: in Instagram, the account's own sent messages sit on the right, the other person's on the left. Use "setter" for our own messages and "prospect" for theirs.
- Ignore interface furniture: timestamps, "Seen", reactions, typing indicators, the message box, story replies rendered as attachments.
- Keep the messages in the order they appear, oldest first.
- If the image is not a conversation at all, set looks_like_conversation to false and return no lines.`;

export const screenshotSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    looks_like_conversation: { type: "boolean" },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sender: { type: "string", enum: ["setter", "prospect"] },
          text: { type: "string", description: "Exactly what is written, verbatim." },
          confidence: { type: "string", enum: ["high", "low"] },
          partial: { type: "boolean", description: "True when the line is cut off or obscured." },
        },
        required: ["sender", "text", "confidence", "partial"],
      },
    },
    unreadable: {
      type: "array",
      items: { type: "string", description: "Where something could not be read. Never a guess at its content." },
    },
    notes: { type: ["string", "null"] },
  },
  required: ["looks_like_conversation", "lines", "unreadable", "notes"],
} as const;

/** Lines the operator must look at before anything is written. */
export function needsReview(reading: ScreenshotReading): boolean {
  return reading.lines.some((l) => l.confidence === "low" || l.partial) || reading.unreadable.length > 0;
}

/**
 * Drops lines already in the thread.
 *
 * A screenshot usually includes the previous few messages for context, and
 * appending those again would have the setter reading the same exchange twice.
 */
export function newLinesOnly(lines: ScreenshotLine[], existing: Message[]): ScreenshotLine[] {
  const seen = new Set(existing.map((m) => normalise(m.message_text)));
  return lines.filter((line) => {
    const key = normalise(line.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,!?]+$/, "");
}

/**
 * A last check before the thread is written to.
 *
 * The operator can correct the sender and the wording in the preview, so what
 * arrives here is their text, not the model's. This only refuses what is empty
 * or obviously not a message.
 */
export function validateLines(lines: { sender: string; text: string }[]): {
  ok: ScreenshotLine[];
  rejected: { text: string; reason: string }[];
} {
  const ok: ScreenshotLine[] = [];
  const rejected: { text: string; reason: string }[] = [];

  for (const line of lines) {
    const text = (line.text ?? "").trim();
    if (!text) {
      rejected.push({ text: "", reason: "empty" });
      continue;
    }
    if (line.sender !== "setter" && line.sender !== "prospect") {
      rejected.push({ text: text.slice(0, 60), reason: `unknown sender "${line.sender}"` });
      continue;
    }
    ok.push({ sender: line.sender, text, confidence: "high", partial: false });
  }
  return { ok, rejected };
}
