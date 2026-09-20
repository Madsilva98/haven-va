/**
 * Daily heads-up for intro packs about to lapse, filtered to the two
 * patterns worth a proactive nudge (see
 * src/lib/intro-pack-conversion.ts's findExpiringIntroPacksToWatch for the
 * exact rule). Plain Telegram digest to the founders' group — no Notion
 * write, unlike leads-intro-pack.ts, since this isn't a "someone to
 * follow up with" backlog item, just a same-day prompt.
 *
 * Schedule: 08:15 Europe/Lisbon every day. Registered in src/server.ts.
 */

import { findExpiringIntroPacksToWatch } from "../lib/intro-pack-conversion.js";
import { log } from "../lib/log.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatExpiringIntroPacksDigest } from "../messages/intro-pack-expiring.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function run(): Promise<void> {
  if (!isStudioSupabaseAvailable()) {
    log.debug("intro_pack_expiring.skipped", { reason: "studio_supabase_not_configured" });
    return;
  }

  let packs: Awaited<ReturnType<typeof findExpiringIntroPacksToWatch>>;
  try {
    packs = await findExpiringIntroPacksToWatch();
  } catch (err) {
    log.error("intro_pack_expiring.fetch_failed", { message: errMsg(err) });
    return;
  }

  const message = formatExpiringIntroPacksDigest(packs);
  if (!message) {
    log.info("intro_pack_expiring.no_matches", { total: packs.length });
    return;
  }

  try {
    const messageId = await sendGroupMessage(message);
    log.info("intro_pack_expiring.posted", { messageId, count: packs.length });
  } catch (err) {
    log.error("intro_pack_expiring.send_failed", { message: errMsg(err) });
  }
}
