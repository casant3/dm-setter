import "dotenv/config";
import path from "node:path";
import { EXPECTED_CARDS, EXPECTED_PARTS, EXPECTED_SCREENSHOTS, orderScreenshots, scanDataset, setterFromCard, handleFromCardName } from "@/ingest/dataset";

/**
 * Validates the Trello screenshot corpus before anything is ingested.
 *
 * Usage: npm run ingest:validate -- [datasetDir]
 * Default datasetDir is data/trello.
 *
 * Exits non-zero when the dataset is incomplete, so a broken corpus can never
 * silently become training data.
 */
async function main() {
  const dir = path.resolve(process.argv[2] ?? "data/trello");
  console.log(`Scanning dataset in ${dir}\n`);

  const report = await scanDataset(dir);

  console.log(`Parts present : ${report.parts_present.length}/${EXPECTED_PARTS} [${report.parts_present.join(", ")}]`);
  if (report.parts_missing.length) console.log(`Parts MISSING : ${report.parts_missing.join(", ")}`);
  console.log(`Cards         : ${report.cards.length}/${EXPECTED_CARDS}`);
  console.log(`Screenshots   : ${report.total_screenshots}/${EXPECTED_SCREENSHOTS}`);
  console.log(`Duplicate attachment ids deduplicated: ${report.duplicate_attachments.length}`);

  const byOutcome = new Map<string, { cards: number; shots: number }>();
  for (const card of report.cards) {
    const agg = byOutcome.get(card.outcome) ?? { cards: 0, shots: 0 };
    agg.cards += 1;
    agg.shots += card.screenshots.length;
    byOutcome.set(card.outcome, agg);
  }

  console.log("\nBy Trello list:");
  for (const [outcome, agg] of [...byOutcome].sort((a, b) => b[1].shots - a[1].shots)) {
    console.log(`  ${outcome.padEnd(40)} cards=${String(agg.cards).padStart(3)}  screenshots=${String(agg.shots).padStart(3)}`);
  }

  if (report.cards_missing_metadata.length) {
    console.log(`\nCards without card_metadata.json (${report.cards_missing_metadata.length}):`);
    for (const c of report.cards_missing_metadata.slice(0, 10)) console.log(`  ${c}`);
  }

  if (report.count_mismatches.length) {
    console.log(`\nScreenshot count disagrees with Trello attachment_count (${report.count_mismatches.length}):`);
    for (const m of report.count_mismatches.slice(0, 15)) {
      console.log(`  ${m.short_link}: Trello says ${m.expected}, found ${m.found}`);
    }
  }

  const noHandle = report.cards.filter((c) => !handleFromCardName(c.metadata?.name));
  const noSetter = report.cards.filter((c) => !setterFromCard(c.metadata));
  console.log(`\nCards without a parseable @handle : ${noHandle.length}`);
  console.log(`Cards without a setter attribution: ${noSetter.length}`);

  const setters = new Map<string, number>();
  for (const c of report.cards) {
    const s = setterFromCard(c.metadata) ?? "(unattributed)";
    setters.set(s, (setters.get(s) ?? 0) + 1);
  }
  console.log("\nConversations per setter:");
  for (const [s, n] of [...setters].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }

  const sample = report.cards[0];
  if (sample) {
    console.log(`\nExample chronological ordering for ${sample.folder}:`);
    for (const shot of orderScreenshots(sample.screenshots).slice(0, 4)) {
      console.log(`  ${shot.attachment_id}  ${path.basename(shot.entry)}`);
    }
  }

  if (report.problems.length) {
    console.log("\nPROBLEMS:");
    for (const p of report.problems) console.log(`  - ${p}`);
  }

  console.log(`\nDataset complete: ${report.complete ? "YES" : "NO"}`);
  if (!report.complete) {
    console.log("Ingestion is blocked until the dataset validates. No transcripts will be produced.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
