/**
 * Bot Feedback writer — best-effort wrapper around `notion.logFeedback`.
 *
 * Failures are logged but never thrown: feedback logging must never
 * block a user-facing flow.
 */
import { notion } from "./notion.js";
import { log } from "./lib/log.js";
export async function record(type, originalMsg, sender, botExtraction, userAction, userText) {
    let serialized;
    try {
        serialized =
            typeof botExtraction === "string"
                ? botExtraction
                : JSON.stringify(botExtraction);
    }
    catch (err) {
        log.warn("feedback.serialize_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        serialized = String(botExtraction);
    }
    const entry = {
        type,
        originalMsg,
        sender,
        botExtraction: serialized,
        userAction,
        ...(userText !== undefined ? { userText } : {}),
    };
    try {
        await notion.logFeedback(entry);
    }
    catch (err) {
        log.warn("feedback.log_failed", {
            type,
            sender,
            message: err instanceof Error ? err.message : String(err),
        });
        // Best-effort — swallow.
    }
}
