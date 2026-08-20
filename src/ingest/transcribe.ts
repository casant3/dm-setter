import { getOpenAI, openaiConfigured } from "@/core/openai";
import { record } from "@/core/observability";
import type { Sender } from "@/lib/types";

/**
 * Screenshot → transcript.
 *
 * The output is explicitly untrusted. Every message carries a confidence and
 * unreadable spans are marked rather than guessed, because a fabricated line in
 * the training corpus is worse than a missing one. Nothing here sets a
 * conversation to `verified`; only a human can do that.
 */

export const UNREADABLE = "[unreadable]";

export type TranscribedMessage = {
  sender: Sender;
  text: string;
  /** 0–1. Below REVIEW_THRESHOLD the whole conversation needs human eyes. */
  confidence: number;
  /** Attachment id of the screenshot this came from. */
  source_screenshot: string;
  /** Position within that screenshot, top to bottom. */
  index_in_screenshot: number;
  /** True when the model marked any part of the text unreadable. */
  uncertain: boolean;
};

export type ScreenshotTranscription = {
  attachment_id: string;
  messages: TranscribedMessage[];
  /** Model's own confidence that it read the image correctly. */
  confidence: number;
  notes: string | null;
};

export type ConversationTranscript = {
  messages: TranscribedMessage[];
  transcript_confidence: number;
  ordering_confidence: number;
  uncertain_message_count: number;
  duplicates_removed: number;
  status: "needs_review" | "pending_ocr";
};

/** Below this, a transcript must not be auto-promoted even by a bulk approve. */
export const REVIEW_THRESHOLD = 0.75;

export const TRANSCRIBE_PROMPT = `You are transcribing a screenshot of an Instagram DM conversation.

Return every message visible in the image, in top-to-bottom order.

Rules:
- Attribute each message to "setter" (the account that initiated outreach, usually shown as the outgoing/right-aligned messages) or "prospect" (incoming/left-aligned).
- If you cannot tell who sent a message, use "prospect" and set confidence below 0.5.
- Transcribe text EXACTLY as written, including lowercase, typos and slang.
- If any part of a message is cut off, blurred or unreadable, write ${UNREADABLE} in place of that span and set uncertain true. NEVER guess at unreadable text.
- Do not summarise, correct grammar, or merge messages.
- Ignore UI chrome: timestamps, "Seen", reactions, typing indicators, profile headers.
- If the image contains no conversation, return an empty messages array.`;

const transcriptionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          sender: { type: "string", enum: ["setter", "prospect"] },
          text: { type: "string" },
          confidence: { type: "number" },
          uncertain: { type: "boolean" },
        },
        required: ["sender", "text", "confidence", "uncertain"],
      },
    },
    image_confidence: { type: "number" },
    notes: { type: ["string", "null"] },
  },
  required: ["messages", "image_confidence", "notes"],
} as const;

/**
 * Transcribes one screenshot with a vision model.
 *
 * Requires OPENAI_API_KEY. There is no offline fallback on purpose: inventing a
 * transcript would poison the corpus, so the pipeline stops instead.
 */
export async function transcribeScreenshot(
  image: Buffer,
  attachmentId: string,
  mimeType = "image/png",
): Promise<ScreenshotTranscription> {
  if (!openaiConfigured()) {
    throw new Error(
      "OPENAI_API_KEY is required to transcribe screenshots. Transcription is never faked — set the key and re-run.",
    );
  }

  const started = Date.now();
  const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
  const dataUrl = `data:${mimeType};base64,${image.toString("base64")}`;

  const response = await getOpenAI().responses.create({
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: TRANSCRIBE_PROMPT },
          { type: "input_image", image_url: dataUrl, detail: "high" },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "dm_transcription", strict: true, schema: transcriptionSchema } },
  } as never);

  const raw = (response as { output_text: string; usage?: { input_tokens?: number; output_tokens?: number } });
  record({
    op: "transcribe",
    ms: Date.now() - started,
    model,
    tokens_in: raw.usage?.input_tokens,
    tokens_out: raw.usage?.output_tokens,
  });

  const parsed = JSON.parse(raw.output_text) as {
    messages: { sender: Sender; text: string; confidence: number; uncertain: boolean }[];
    image_confidence: number;
    notes: string | null;
  };

  return {
    attachment_id: attachmentId,
    confidence: parsed.image_confidence,
    notes: parsed.notes,
    messages: parsed.messages.map((m, i) => ({
      sender: m.sender,
      text: m.text,
      confidence: m.confidence,
      uncertain: m.uncertain || m.text.includes(UNREADABLE),
      source_screenshot: attachmentId,
      index_in_screenshot: i,
    })),
  };
}

// ---------------------------------------------------------------------------
// Overlap handling
// ---------------------------------------------------------------------------

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w ]/g, "").trim();
}

/** Two messages are the same if the same sender says near-identical text. */
function sameMessage(a: TranscribedMessage, b: TranscribedMessage): boolean {
  if (a.sender !== b.sender) return false;
  const x = normalize(a.text);
  const y = normalize(b.text);
  if (!x || !y) return false;
  if (x === y) return true;
  // Screenshots often clip the first or last line, leaving a strict prefix.
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 15 && longer.startsWith(shorter);
}

/**
 * Merges consecutive screenshots into one conversation.
 *
 * Consecutive screenshots of a scrolling thread overlap heavily. The overlap is
 * the signal that two screenshots are adjacent, so it both deduplicates messages
 * and corroborates the ordering: screenshots that share a boundary raise
 * ordering confidence, and ones that share nothing lower it.
 */
export function mergeScreenshots(screenshots: ScreenshotTranscription[]): ConversationTranscript {
  const merged: TranscribedMessage[] = [];
  let duplicates = 0;
  let adjacentPairs = 0;
  let comparablePairs = 0;

  for (let s = 0; s < screenshots.length; s += 1) {
    const shot = screenshots[s];
    let overlapFound = false;

    for (const message of shot.messages) {
      // Only look back over a window: the same words can legitimately recur
      // much later in a long conversation.
      const windowStart = Math.max(0, merged.length - 12);
      const duplicateIndex = merged.slice(windowStart).findIndex((existing) => sameMessage(existing, message));

      if (duplicateIndex !== -1) {
        const absolute = windowStart + duplicateIndex;
        duplicates += 1;
        overlapFound = true;
        // Keep whichever reading is more confident and less truncated.
        const existing = merged[absolute];
        const better =
          message.confidence > existing.confidence || message.text.length > existing.text.length ? message : existing;
        merged[absolute] = { ...better, uncertain: existing.uncertain && message.uncertain };
        continue;
      }
      merged.push(message);
    }

    if (s > 0 && screenshots[s - 1].messages.length > 0 && shot.messages.length > 0) {
      comparablePairs += 1;
      if (overlapFound) adjacentPairs += 1;
    }
  }

  const uncertain = merged.filter((m) => m.uncertain).length;
  const imageConfidences = screenshots.map((s) => s.confidence).filter((c) => Number.isFinite(c));
  const transcriptConfidence = imageConfidences.length
    ? imageConfidences.reduce((a, b) => a + b, 0) / imageConfidences.length
    : 0;

  // With one screenshot there is nothing to corroborate, so ordering is assumed
  // from upload order at moderate confidence rather than asserted.
  const orderingConfidence =
    comparablePairs === 0 ? (screenshots.length <= 1 ? 0.6 : 0.5) : adjacentPairs / comparablePairs;

  return {
    messages: merged,
    transcript_confidence: Number(transcriptConfidence.toFixed(3)),
    ordering_confidence: Number(orderingConfidence.toFixed(3)),
    uncertain_message_count: uncertain,
    duplicates_removed: duplicates,
    status: "needs_review",
  };
}

/** Renders a merged transcript for human review. */
export function renderTranscript(transcript: ConversationTranscript): string {
  return transcript.messages
    .map((m) => `${m.sender === "setter" ? "Setter" : "Prospect"}: ${m.text}${m.uncertain ? "  ⚠️" : ""}`)
    .join("\n");
}
