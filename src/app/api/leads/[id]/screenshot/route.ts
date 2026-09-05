import { getOpenAI, openaiConfigured } from "@/core/openai";
import { record } from "@/core/observability";
import {
  SCREENSHOT_INSTRUCTIONS,
  needsReview,
  newLinesOnly,
  screenshotSchema,
  validateLines,
  type ScreenshotReading,
} from "@/core/screenshot";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";
import type { Sender } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = {
  /** A data URL or bare base64 of the screenshot. Only used to read it. */
  image?: string;
  mime_type?: string;
  /** On commit: the lines the operator confirmed, after any corrections. */
  lines?: { sender: Sender; text: string }[];
  commit?: boolean;
};

/** Refuses anything large enough to be a video or a burst of images. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reads a screenshot of a conversation into the thread.
 *
 * Two steps, deliberately. The first reads the image and returns what it saw,
 * marked up with what it could not read clearly — nothing is written. The
 * second takes the lines the operator confirmed, which may be corrected, and
 * appends those.
 *
 * The image itself is never stored. It goes to the model, the text comes back,
 * and the bytes are dropped: a transcript is what the app needs, and keeping a
 * copy of every prospect's DMs as image files is a liability with no upside.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);
    const store = getStore();

    const lead = await store.getLead(id);
    if (!lead) return fail("Lead not found", 404);

    // --- commit: the operator has reviewed the lines -----------------------
    if (body.commit) {
      const { ok: lines, rejected } = validateLines(body.lines ?? []);
      if (lines.length === 0) return fail("No lines to add");

      const appended = await store.appendMessages(
        id,
        lines.map((line) => ({ sender: line.sender, message_text: line.text })),
      );
      return ok({
        added: appended.length,
        rejected,
        note: "Added to the thread. The screenshot itself was not stored.",
      });
    }

    // --- read the image ----------------------------------------------------
    if (!openaiConfigured()) {
      return fail(
        "Reading screenshots needs OPENAI_API_KEY. Transcription is never faked — set the key, or paste the text instead.",
        503,
      );
    }

    const raw = body.image?.trim();
    if (!raw) return fail("Attach a screenshot");

    const match = raw.match(/^data:([\w/+.-]+);base64,(.*)$/s);
    const mimeType = match?.[1] ?? body.mime_type ?? "image/png";
    const base64 = match?.[2] ?? raw;
    if (!/^image\/(png|jpe?g|webp|heic|heif)$/i.test(mimeType)) {
      return fail(`${mimeType} is not an image this can read`);
    }
    if (Buffer.byteLength(base64, "base64") > MAX_BYTES) {
      return fail("That image is too large. Send a single screenshot rather than a long capture.");
    }

    const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-5.6";
    const started = Date.now();
    const response = (await getOpenAI().responses.create({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: SCREENSHOT_INSTRUCTIONS },
            { type: "input_image", image_url: `data:${mimeType};base64,${base64}`, detail: "high" },
          ],
        },
      ],
      text: { format: { type: "json_schema", name: "dm_screenshot", strict: true, schema: screenshotSchema } },
    } as never)) as { output_text: string; usage?: { input_tokens?: number; output_tokens?: number } };

    record({
      op: "screenshot",
      model,
      ms: Date.now() - started,
      tokens_in: response.usage?.input_tokens,
      tokens_out: response.usage?.output_tokens,
    });

    const reading = JSON.parse(response.output_text) as ScreenshotReading;
    if (!reading.looks_like_conversation) {
      return fail("That does not look like a DM conversation. Send the screenshot of the thread itself.", 422);
    }

    // Screenshots normally include the last few messages for context; those are
    // already in the thread and must not be appended twice.
    const existing = await store.listMessages(id);
    const fresh = newLinesOnly(reading.lines, existing);

    return ok({
      preview: true,
      lines: fresh,
      already_in_thread: reading.lines.length - fresh.length,
      unreadable: reading.unreadable,
      needs_review: needsReview({ ...reading, lines: fresh }),
      notes: reading.notes,
      note: "Check the wording and who said what before adding it. Nothing has been written yet.",
    });
  } catch (error) {
    return handleError(error);
  }
}
