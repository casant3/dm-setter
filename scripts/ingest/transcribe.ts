import "dotenv/config";
import path from "node:path";
import { openaiConfigured } from "@/core/openai";
import { readZipFile, scanDataset } from "@/ingest/dataset";
import { extractConversations, loadBoardExport } from "@/ingest/extract";
import { REVIEW_THRESHOLD, mergeScreenshots, renderTranscript, transcribeScreenshot } from "@/ingest/transcribe";
import { getStore } from "@/lib/store";

/**
 * Stage 3 of ingestion: screenshots → draft transcripts.
 *
 * Usage:
 *   npm run ingest:transcribe -- [datasetDir] [--limit N] [--handle x] [--dry-run]
 *
 * Every transcript lands as `needs_review`. Nothing here can mark a conversation
 * verified, and nothing it produces is eligible for retrieval until a human
 * approves it. Requires OPENAI_API_KEY — transcription is never faked.
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
  const handleArg = args.indexOf("--handle");
  const onlyHandle = handleArg >= 0 ? args[handleArg + 1] : null;
  const dir = path.resolve(args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) ?? "data/trello");

  if (!openaiConfigured()) {
    console.error("OPENAI_API_KEY is not set.");
    console.error("Transcription uses a vision model and is never faked, so this stage cannot run without it.");
    console.error("Set the key and re-run; stages 1 (validate) and 2 (extract) work without it.");
    process.exit(1);
  }

  const report = await scanDataset(dir);
  if (!report.complete) {
    console.error("Dataset does not validate. Run `npm run ingest:validate` first.");
    process.exit(1);
  }

  const board = await loadBoardExport(path.join(dir, "trello_board_export.json"));
  let conversations = extractConversations(report, board);
  if (onlyHandle) conversations = conversations.filter((c) => c.instagram_handle === onlyHandle.replace(/^@/, ""));
  conversations = conversations.slice(0, Number.isFinite(limit) ? limit : undefined);

  const store = getStore();
  console.log(`Transcribing ${conversations.length} conversation(s)\n`);

  for (const conversation of conversations) {
    const shots = [];
    for (const shot of conversation.screenshots) {
      const image = await readZipFile(shot.zip, shot.entry);
      const mime = /\.jpe?g$/i.test(shot.entry) ? "image/jpeg" : "image/png";
      shots.push(await transcribeScreenshot(image, shot.attachment_id, mime));
    }

    const merged = mergeScreenshots(shots);
    const flag = merged.transcript_confidence < REVIEW_THRESHOLD ? "  LOW CONFIDENCE" : "";
    console.log(
      `@${conversation.instagram_handle ?? "?"} [${conversation.outcome_tier}] ` +
        `${merged.messages.length} msgs, ${merged.duplicates_removed} dupes removed, ` +
        `conf=${merged.transcript_confidence} order=${merged.ordering_confidence}, ` +
        `${merged.uncertain_message_count} uncertain${flag}`,
    );

    if (dryRun) continue;

    await store.upsertSourceConversation({
      external_card_id: conversation.external_card_id,
      instagram_handle: conversation.instagram_handle,
      setter_name: conversation.setter_name,
      outcome: conversation.outcome,
      outcome_tier: conversation.outcome_tier,
      transcript: renderTranscript(merged),
      screenshot_paths: conversation.screenshots,
      outcome_history: conversation.outcome_history,
      status: "needs_review",
      labels: {
        messages: merged.messages,
        transcript_confidence: merged.transcript_confidence,
        ordering_confidence: merged.ordering_confidence,
        uncertain_message_count: merged.uncertain_message_count,
        duplicates_removed: merged.duplicates_removed,
      },
    });
  }

  console.log(
    dryRun
      ? "\n--dry-run: nothing written."
      : "\nAll transcripts stored as needs_review. Approve them in the app (Corpus tab) before they can influence suggestions.",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
