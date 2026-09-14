/**
 * One-shot interactive OAuth setup for the Outlook partnerships sync.
 *
 * Prints a Microsoft sign-in URL, waits for you to paste back the
 * redirected URL (or bare `code=` value), then exchanges it and writes
 * outlook-tokens.json under DATA_DIR.
 *
 * Requires MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT_ID
 * in .env (loaded via `node --env-file`). See
 * docs/knowledge-base/outlook-partnerships-sync.md for the Azure app
 * registration steps this depends on.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/outlook-auth.mjs
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import * as outlook from "../dist/lib/outlook.js";

const rl = readline.createInterface({ input: stdin, output: stdout });

try {
  console.log("Open this URL, sign in, and authorize:\n");
  console.log(outlook.getAuthUrl());
  console.log(
    "\nAfter authorizing you'll land on a page that fails to load (that's expected —",
  );
  console.log("the redirect URI isn't a real server). Copy the full URL from the address");
  console.log("bar, or just the value after `code=`.\n");

  const pasted = await rl.question("Paste the redirected URL or code: ");
  await outlook.exchangeCodeForToken(pasted);

  console.log("\n✓ Authenticated — tokens saved.");
} catch (err) {
  console.error("\n✗ Failed:", err.message ?? err);
  process.exitCode = 1;
} finally {
  rl.close();
}
