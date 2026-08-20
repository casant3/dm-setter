import "dotenv/config";
import { openaiConfigured } from "@/core/openai";
import { buildChunks } from "@/ingest/chunk";
import { labelConversation } from "@/ingest/labels";
import type { TranscribedMessage } from "@/ingest/transcribe";
import { getStore } from "@/lib/store";
import type { OutcomeTier } from "@/lib/types";

/**
 * Stage 4 of ingestion: verified transcripts → labelled, embedded chunks.
 *
 * Usage: npm run ingest:chunk -- [--dry-run]
 *
 * Only conversations a human marked `verified` are processed. Re-running is
 * idempotent: a conversation's chunks are replaced wholesale, never appended.
 */
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const store = getStore();

  const verified = await store.listSourceConversations("verified");
  if (verified.length === 0) {
    console.log("No verified conversations yet.");
    console.log("Run ingest:transcribe, then approve transcripts in the app's Corpus tab.");
    return;
  }

  if (!dryRun && store.mode === "supabase" && !openaiConfigured()) {
    console.error("OPENAI_API_KEY is required to embed chunks into Supabase.");
    process.exit(1);
  }

  let totalChunks = 0;
  for (const conversation of verified) {
    const labelsBlob = (conversation.labels ?? {}) as { messages?: TranscribedMessage[] };
    const messages = labelsBlob.messages ?? [];
    if (messages.length === 0) {
      console.log(`@${conversation.instagram_handle ?? "?"}: no structured messages stored, skipping.`);
      continue;
    }

    const tier = (conversation.outcome_tier ?? "D") as OutcomeTier;
    const labels = labelConversation(messages, tier);
    const chunks = buildChunks({
      conversationId: conversation.id,
      messages,
      labels,
      outcome: conversation.outcome ?? "",
      outcome_tier: tier,
      niche: null,
      industry: null,
      setter_name: conversation.setter_name,
      handle: conversation.instagram_handle,
    });

    console.log(
      `@${conversation.instagram_handle ?? "?"} [${tier}] → ${chunks.length} chunks, ` +
        `quality=${labels.quality_score}${labels.premature_cta ? ", premature CTA" : ""}`,
    );

    if (!dryRun) {
      await store.replaceChunksForConversation(conversation.id, chunks);
    }
    totalChunks += chunks.length;
  }

  console.log(dryRun ? `\n--dry-run: ${totalChunks} chunks would be written.` : `\nWrote ${totalChunks} chunks.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
