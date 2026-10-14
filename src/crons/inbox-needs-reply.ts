/**
 * Instagram "who is waiting for a reply" (haven-studio Instagram DM plan, step 3).
 *
 * run(), 08:30 daily: judges the new candidate threads with Haiku (verdicts to
 * va.inbox_thread_labels), then posts the threads still owed a reply to the group, oldest first,
 * with the hours left in Instagram's 24h window. Nothing owed = no post.
 *
 * Follows the house rules: one morning post, to the group, after the 08:15 intro-pack digest
 * (pipeline-alerts went from every 4h to once a morning, 2026-09-15, "too much"; alerts post to the
 * group since 2026-09-30). New leads still go to "Leads a contactar" via the Monday Instagram scan;
 * this post only says who is waiting, so the two do not duplicate.
 *
 * OPEN for Madalena: the cadence (once a morning is a placeholder), to be set alongside the other
 * commercial efforts (lead scans, intro-pack nudges, churn risk). Test week until
 * INBOX_DIGEST_SHADOW_UNTIL (default 2026-10-20): the post asks for wrong ones so the prompt
 * (src/prompts/inbox-needs-reply.md) can be tuned.
 */

import { fetchWaiting, formatDigest, labelCandidates } from "../lib/inbox-needs-reply.js";
import { log } from "../lib/log.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendGroupMessage } from "../lib/telegram.js";

const SHADOW_UNTIL = process.env.INBOX_DIGEST_SHADOW_UNTIL ?? "2026-10-20";

export async function run(): Promise<void> {
  if (!isStudioDbAvailable()) return;
  const labelled = await labelCandidates();
  log.info("cron.inbox_needs_reply.labelled", labelled);
  const now = new Date();
  const text = formatDigest(await fetchWaiting(), now, now.toISOString().slice(0, 10) <= SHADOW_UNTIL);
  if (!text) {
    log.info("cron.inbox_needs_reply.nothing_waiting");
    return;
  }
  await sendGroupMessage(text);
  log.info("cron.inbox_needs_reply.posted");
}
