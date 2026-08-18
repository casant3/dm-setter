import { randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { generateSalt, hashPassword } from "@/lib/auth";

/**
 * Generates the auth environment values.
 *
 * Usage: npm run auth:setup
 *
 * Prints values to paste into .env. Nothing is written to disk here, so the
 * password never lands in a file this script controls.
 */
async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const password = (await rl.question("Choose a password for the app: ")).trim();
    if (password.length < 12) {
      console.error("\nUse at least 12 characters. This is the only thing between the internet and your prospect conversations.");
      process.exit(1);
    }

    const salt = generateSalt();
    const hash = hashPassword(password, salt);
    const secret = randomBytes(32).toString("hex");

    console.log("\nAdd these to .env (never commit them):\n");
    console.log(`APP_PASSWORD_SALT=${salt}`);
    console.log(`APP_PASSWORD_HASH=${hash}`);
    console.log(`SESSION_SECRET=${secret}`);
    console.log("\nRestart the app, then sign in at /login.");
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
