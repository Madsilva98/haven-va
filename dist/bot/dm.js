/**
 * DM router — handles private chats with founders.
 *
 * Slash commands (/week, /focus) are handled first. Free text goes to
 * the conversational assistant. Strangers get one polite message.
 */
import { getFounderName, isFounder } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { ErrorRateLimit, ERROR_MESSAGE } from "../messages/errors.js";
import * as notion from "../notion.js";
import { handleAssistant } from "./assistant.js";
import { pushRecent, getPriors, lastBotRepliesByChat } from "./history.js";
import { handleFocus, isFocusCommand } from "./focus.js";
import { handleWeek, handleWeekTextStep, isWeekCommand, isAwaitingFocusFor, } from "./week.js";
const STRANGER_REPLY = "este bot só funciona para a equipa do Haven";
const warnedStrangers = new Set();
const errorLimit = new ErrorRateLimit();
/**
 * Returns true if the update was handled here.
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
    const text = ctx.message?.text;
    if (!text)
        return false;
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
    if (isAwaitingFocusFor(fromId)) {
        try {
            await handleWeekTextStep(ctx, senderName, text);
        }
        catch (err) {
            log.error("dm.week_text_step_failed", { err: String(err) });
        }
        return true;
    }
    const hasNonTextMedia = Boolean(ctx.message?.photo ||
        ctx.message?.video ||
        ctx.message?.voice ||
        ctx.message?.audio ||
        ctx.message?.document ||
        ctx.message?.sticker);
    if (hasNonTextMedia)
        return true;
    if (text.trim().length < 4)
        return true;
    const chatId = ctx.chat.id;
    pushRecent(chatId, senderName, text);
    const calendarKeywords = /calendar|calend|social media|content|story|stories|post|reel|conteúdo|publicaç/i;
    let contentCalendar;
    if (calendarKeywords.test(text)) {
        try {
            contentCalendar = await notion.getContentCalendarRows();
        }
        catch (err) {
            log.warn("dm.calendar_fetch_failed", { err: String(err) });
        }
    }
    let openTasks = [];
    try {
        openTasks = await notion.getOpenTasksFor(senderName);
    }
    catch (err) {
        log.warn("dm.open_tasks_fetch_failed", { err: String(err) });
    }
    try {
        const botReplies = await handleAssistant(ctx, senderName, text, getPriors(chatId), undefined, contentCalendar, lastBotRepliesByChat.get(chatId), openTasks);
        if (botReplies.length > 0) {
            lastBotRepliesByChat.set(chatId, botReplies);
        }
    }
    catch (err) {
        log.error("dm.assistant_failed", { err: String(err) });
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
