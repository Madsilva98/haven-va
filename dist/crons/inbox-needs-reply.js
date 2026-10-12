/**
 * Instagram "who is waiting for a reply" (haven-studio Instagram DM plan, step 3).
 *
 * run():       every 15 min, 08:00-22:00 Lisbon. Judges new candidate threads with Haiku and writes
 *              the verdict to va.inbox_thread_labels. Silent.
 * runDigest(): 09:30 and 18:30. DMs Madalena the threads still owed a reply, oldest first, with the
 *              hours left in Instagram's 24h window. Nothing owed = no message.
 *
 * Shadow week (until INBOX_DIGEST_SHADOW_UNTIL, default 2026-10-20): the digest asks her to point out
 * wrong ones, so the prompt (src/prompts/inbox-needs-reply.md) can be tuned before anyone relies on it.
 */
import { getTelegramId } from "../lib/founders.js";
import { fetchWaiting, formatDigest, labelCandidates } from "../lib/inbox-needs-reply.js";
import { log } from "../lib/log.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendDM } from "../lib/telegram.js";
const SHADOW_UNTIL = process.env.INBOX_DIGEST_SHADOW_UNTIL ?? "2026-10-20";
export async function run() {
    if (!isStudioDbAvailable())
        return;
    const r = await labelCandidates();
    if (r.judged || r.failed)
        log.info("cron.inbox_needs_reply.labelled", r);
}
export async function runDigest() {
    if (!isStudioDbAvailable())
        return;
    await run(); // judge anything new first, so the digest is not full of "por classificar"
    const now = new Date();
    const text = formatDigest(await fetchWaiting(), now, now.toISOString().slice(0, 10) <= SHADOW_UNTIL);
    if (!text) {
        log.info("cron.inbox_needs_reply.digest_empty");
        return;
    }
    const telegramId = getTelegramId("Madalena");
    if (telegramId === null) {
        log.warn("cron.inbox_needs_reply.no_telegram_id");
        return;
    }
    await sendDM(telegramId, text);
    log.info("cron.inbox_needs_reply.digest_sent");
}
