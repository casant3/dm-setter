import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { parseDmTranscript, sequenceTimestamps } from "@/lib/dm-parser";
import { getStore } from "@/lib/store";
import type { Sender } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = {
  transcript: string;
  /** When false, the response is a preview and nothing is written. */
  commit?: boolean;
  /** Speaker labels the user mapped by hand in the preview step. */
  label_overrides?: Record<string, Sender>;
};

/**
 * Parses a pasted DM thread. Without `commit` it returns a preview so the user
 * can check the speaker mapping before anything touches the conversation.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);
    const transcript = String(body.transcript ?? "");
    if (!transcript.trim()) return fail("Paste a conversation first");

    const store = getStore();
    const lead = await store.getLead(id);
    if (!lead) return fail("Lead not found", 404);

    const parsed = parseDmTranscript(transcript, {
      prospectAliases: [lead.instagram_handle, lead.name ?? "", lead.name?.split(" ")[0] ?? ""].filter(Boolean),
    });

    const overrides = body.label_overrides ?? {};
    const messages = sequenceTimestamps(
      parsed.messages.map((m) => {
        const override = overrides[m.label];
        return override ? { ...m, sender: override } : m;
      }),
    );

    if (!body.commit) {
      return ok({
        preview: messages,
        unknown_labels: parsed.unknownLabels,
        warnings: parsed.warnings,
        counts: {
          total: messages.length,
          setter: messages.filter((m) => m.sender === "setter").length,
          prospect: messages.filter((m) => m.sender === "prospect").length,
        },
      });
    }

    if (messages.length === 0) return fail("Nothing to import");

    const inserted = await store.appendMessages(
      id,
      messages.map((m) => ({ sender: m.sender, message_text: m.message_text, sent_at: m.sent_at ?? undefined })),
    );
    return ok({ imported: inserted.length, messages: await store.listMessages(id) }, 201);
  } catch (error) {
    return handleError(error);
  }
}
