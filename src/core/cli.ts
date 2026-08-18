import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runSetter } from "./agent.js";

const rl = readline.createInterface({ input, output });
try {
  const handle = await rl.question("Instagram handle (e.g. codyalt): ");
  const msg = await rl.question("Prospect's newest message: ");
  const result = await runSetter(handle.replace(/^@/, "").trim(), msg.trim());
  console.log("\nSTAGE:", result.strategy.stage);
  console.log("QUALIFICATION:", result.strategy.qualification, `TOTAL=${result.strategy.total_score}/12`);
  console.log("CALL READY:", result.strategy.call_ready);
  console.log("NEXT OBJECTIVE:", result.strategy.next_objective);
  console.log("\nSEND THIS:\n", result.reviewer.final_reply);
} finally { rl.close(); }
