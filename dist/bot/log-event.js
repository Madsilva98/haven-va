/**
 * LOG intent handler.
 *
 * Writes the entry to the Studio Log Notion DB and posts a one-line
 * pt-PT ack. Auto-commits — no buttons. Failures are logged but do not
 * surface to the user (the message itself was a status update, not a
 * commitment, so a failed ack is recoverable).
 */
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
export async function handleLog(ctx, intent, sender, originalMessage) {
    try {
        await notion.createLogEntry({
            text: intent.text,
            author: sender,
            tags: intent.tags,
            originalMessage,
        });
        const tagPart = intent.tags.length > 0 ? ` [${intent.tags.join(", ")}]` : "";
        await ctx.reply(`📝 anotado no log: ${intent.text}${tagPart}`);
    }
    catch (err) {
        log.error("log_event.failed", { err: String(err) });
    }
}
