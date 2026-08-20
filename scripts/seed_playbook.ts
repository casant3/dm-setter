import "dotenv/config";
import fs from "node:fs";
import { getDb } from "@/core/db";

type Playbook = { primary_goal: string; sales_rules: string[]; voice_rules: string[] };

async function main() {
  const pb = JSON.parse(fs.readFileSync("config/playbook.json", "utf8")) as Playbook;
  const rows = [
    { rule_key: "primary_goal", rule_text: pb.primary_goal, priority: 100 },
    ...pb.sales_rules.map((x, i) => ({ rule_key: `sales_${i + 1}`, rule_text: x, priority: 90 - i })),
    ...pb.voice_rules.map((x, i) => ({ rule_key: `voice_${i + 1}`, rule_text: x, priority: 70 - i })),
  ];
  const { error } = await getDb().from("setter_playbook").upsert(rows, { onConflict: "rule_key" });
  if (error) throw error;
  console.log(`Seeded ${rows.length} playbook rules`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
