/**
 * Tier 0 pre-filter — pure, side-effect-free, no I/O.
 *
 * `shouldProcess` is the single gate that decides whether a Telegram
 * message is worth running through the Claude pipeline. It runs
 * before any API call, so it must be cheap and deterministic.
 *
 * Drop conditions (in order):
 *   1. text is undefined or empty
 *   2. message contains non-text media (sticker, voice, image, …)
 *   3. message is a reply to one of the bot's own messages
 *   4. text length < MIN_LENGTH (8 chars)
 *   5. text contains no signal verb / temporal keyword
 *
 * Returns `true` only when the message survives all gates.
 */
import { MIN_LENGTH, REGEX_KEYWORDS } from "../prompts/regex-keywords.js";
export function shouldProcess(message) {
    if (message.hasNonTextMedia)
        return false;
    if (message.isReplyToBot)
        return false;
    const text = message.text;
    if (text === undefined)
        return false;
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return false;
    if (trimmed.length < MIN_LENGTH)
        return false;
    if (!REGEX_KEYWORDS.test(trimmed))
        return false;
    return true;
}
