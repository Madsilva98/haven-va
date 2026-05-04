/**
 * DM router — handles private chats with founders.
 *
 * Phase 1's `bot/index.ts` only listens in groups. Phase 2 wires this
 * module in for `chat.type === "private"` updates so:
 *   - the `/week` and `/focus` rituals work in DM (less noise)
 *   - free text in a DM still runs through the Phase 1 pipeline, but
 *     the sender becomes the implicit task owner
 *
 * Strangers (anyone not in the founder map) get one polite message
 * then are silently ignored. Warned-set is in-memory; that's fine
 * because warning the same stranger twice across cold starts is
 * harmless.
 */
import { getFounderName, isFounder } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { ErrorRateLimit, ERROR_MESSAGE } from "../messages/errors.js";
import * as notion from "../notion.js";
import { getRecentActions } from "../state/pending.js";
import { extractIntents } from "./multi-intent.js";
import { route } from "./router.js";
import { shouldProcess } from "./filter.js";
import { handleFocus, isFocusCommand } from "./focus.js";
import { handleWeek, handleWeekCallback, handleWeekTextStep, isWeekCommand, isWeekCallback, isAwaitingFocusFor, } from "./week.js";
const STRANGER_REPLY = "este bot só funciona para a equipa do Haven";
const warnedStrangers = new Set();
const errorLimit = new ErrorRateLimit();
/**
 * Returns true if the update was handled here. The orchestrator can
 * use this to short-circuit the group pipeline.
 */
export async function handleDM(ctx) {
    if (ctx.chat?.type !== "private")
        return false;
    const fromId = ctx.from?.id;
    if (!fromId)
        return false;
    if (!isFounder(fromId)) {
        if (!warnedStrangers.has(fromId)) {
            warnedStrangers.add(fromId);
            try {
                await ctx.reply(STRANGER_REPLY);
            }
            catch (err) {
                log.warn("dm.stranger_reply_failed", { err: String(err) });
            }
        }
        return true;
    }
    const senderName = getFounderName(fromId);
    if (!senderName)
        return false;
    // Inline-button callbacks for the /week wizard.
    const cbData = ctx.callbackQuery?.data;
    if (cbData && isWeekCallback(cbData)) {
        try {
            await handleWeekCallback(ctx, senderName);
        }
        catch (err) {
            log.error("dm.week_callback_failed", { err: String(err) });
        }
        return true;
    }
    const text = ctx.message?.text;
    if (!text)
        return false;
    // Slash commands first.
    if (isWeekCommand(text)) {
        try {
            await handleWeek(ctx, senderName);
        }
        catch (err) {
            log.error("dm.week_failed", { err: String(err) });
            await safeReply(ctx);
        }
        return true;
    }
    if (isFocusCommand(text)) {
        try {
            await handleFocus(ctx, senderName, text);
        }
        catch (err) {
            log.error("dm.focus_failed", { err: String(err) });
            await safeReply(ctx);
        }
        return true;
    }
    // /week wizard last step: founder typed a focus sentence.
    if (isAwaitingFocusFor(fromId)) {
        try {
            await handleWeekTextStep(ctx, senderName, text);
        }
        catch (err) {
            log.error("dm.week_text_step_failed", { err: String(err) });
        }
        return true;
    }
    // Free text → Phase 1 pipeline, with the sender as implicit owner.
    const hasNonTextMedia = Boolean(ctx.message?.photo ||
        ctx.message?.video ||
        ctx.message?.voice ||
        ctx.message?.audio ||
        ctx.message?.document ||
        ctx.message?.sticker);
    if (!shouldProcess({ text, isReplyToBot: false, hasNonTextMedia })) {
        return true;
    }
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
        log.warn("dm.no_chat_id");
        return true;
    }
    let recentBotActions = [];
    let openTasks = [];
    try {
        [recentBotActions, openTasks] = await Promise.all([
            getRecentActions(chatId),
            notion.getOpenTasks(),
        ]);
    }
    catch (err) {
        log.warn("dm.context_fetch_failed", { err: String(err) });
    }
    const chatCtx = {
        text,
        sender: senderName,
        recentMessages: [],
        recentBotActions,
        openTasks,
    };
    try {
        const intents = await extractIntents(chatCtx);
        // DM-specific: if a NEW_TASK has owner=Unassigned, default to sender.
        const adjusted = intents.map((i) => i.type === "NEW_TASK" && i.owner === "Unassigned"
            ? { ...i, owner: senderName }
            : i);
        await route(ctx, chatCtx, adjusted);
    }
    catch (err) {
        log.error("dm.pipeline_error", { err: String(err) });
        await safeReply(ctx);
    }
    return true;
}
async function safeReply(ctx) {
    if (!errorLimit.tryNotify())
        return;
    try {
        await ctx.reply(ERROR_MESSAGE);
    }
    catch (err) {
        log.warn("dm.error_reply_failed", { err: String(err) });
    }
}
