import "dotenv/config";
import path from "node:path";
import { extractConversations, loadBoardExport } from "@/ingest/extract";
import { scanDataset } from "@/ingest/dataset";
import { getStore } from "@/lib/store";

/**
 * Stage 2 of ingestion: identity, outcome and provenance.
 *
 * Usage: npm run ingest:extract -- [datasetDir] [--dry-run]
 *
 * Writes one `source_conversations` row per prospect card with status
 * `pending_ocr`. Re-running is idempotent: rows are keyed on the Trello card id
 * and a transcript already marked `verified` is never overwritten.
 */
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dir = path.resolve(args.find((a) => !a.startsWith("--")) ?? "data/trello");

  const report = await scanDataset(dir);
  if (!report.complete) {
    console.error("Dataset does not validate. Run `npm run ingest:validate` first.");
    for (const p of report.problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const board = await loadBoardExport(path.join(dir, "trello_board_export.json"));
  const conversations = extractConversations(report, board);

  const byTier = new Map<string, number>();
  let notHonoured = 0;
  for (const c of conversations) {
    byTier.set(c.outcome_tier, (byTier.get(c.outcome_tier) ?? 0) + 1);
    if (c.booking_not_honoured) notHonoured += 1;
  }

  console.log(`Extracted ${conversations.length} conversations from ${report.total_screenshots} screenshots\n`);
  console.log("Outcome tiers:");
  for (const tier of ["A", "B", "C", "D", "E", "F"]) {
    console.log(`  Tier ${tier}: ${byTier.get(tier) ?? 0}`);
  }
  console.log(`\nBookings not honoured downstream: ${notHonoured}`);

  console.log("\nSample:");
  for (const c of conversations.slice(0, 5)) {
    console.log(`  @${c.instagram_handle ?? "?"} [${c.outcome_tier}] setter=${c.setter_name ?? "?"} shots=${c.screenshots.length}`);
    console.log(`    ${c.tier_rationale}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  const store = getStore();
  let written = 0;
  for (const c of conversations) {
    await store.upsertSourceConversation({
      external_card_id: c.external_card_id,
      source: "trello",
      instagram_handle: c.instagram_handle,
      setter_name: c.setter_name,
      outcome: c.outcome,
      outcome_tier: c.outcome_tier,
      stage: null,
      notes: c.notes,
      screenshot_paths: c.screenshots,
      outcome_history: c.outcome_history,
      labels: {
        tier_rationale: c.tier_rationale,
        booking_not_honoured: c.booking_not_honoured,
        profile_hints: c.profile_hints,
        card_name: c.card_name,
        comments: c.comments,
      },
      status: "pending_ocr",
    });
    written += 1;
  }
  console.log(`\nWrote ${written} source_conversations rows to the ${store.mode} store (status=pending_ocr).`);
  console.log("Next: npm run ingest:transcribe");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
