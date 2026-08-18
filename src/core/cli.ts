import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultDeps, runSetter } from "@/core/agent";

const rl = readline.createInterface({ input, output });
try {
  const deps = defaultDeps();
  console.log(`store=${deps.store.mode} engine=${deps.llm.engine}\n`);
  const handle = await rl.question("Instagram handle (e.g. codyalt): ");
  const msg = await rl.question("Prospect's newest message: ");
  const result = await runSetter(handle.replace(/^@/, "").trim(), msg.trim(), deps);
  console.log("\nSTAGE:", result.strategy.stage);
  console.log("QUALIFICATION:", result.strategy.qualification, `TOTAL=${result.strategy.total_score}/12`);
  console.log("CALL READY:", result.strategy.call_ready);
  if (!result.gate.passed) console.log("GATE BLOCKERS:", result.gate.blockers.join("; "));
  console.log("NEXT OBJECTIVE:", result.strategy.next_objective);
  if (result.reviewer.issues.length) console.log("REVIEWER ISSUES:", result.reviewer.issues.join("; "));
  console.log("\nSEND THIS:\n", result.reviewer.final_reply);
} finally {
  rl.close();
}
