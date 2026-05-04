/**
 * Bot setup and message router.
 *
 * Handles:
 *   - group messages → Phase 1 pipeline + Phase 5 decisions/launch detection
 *   - private messages → DM router (Phase 2) with same pipeline
 *   - slash commands: /help /start /task /status (Phase 1) + /week /focus
 *     /remind /todiscuss (Phase 2/3/5)
 *   - inline button callbacks: namespaced by data prefix and dispatched
 *     to the right handler
 */
import { Bot } from "grammy";
import * as calendar from "../lib/calendar.js";
import { getFounderName, isFounder } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { ErrorRateLimit, ERROR_MESSAGE } from "../messages/errors.js";
import { WELCOME_MESSAGE } from "../messages/welcome.js";
import * as notion from "../notion.js";
import { getRecentActions } from "../state/pending.js";
// Phase 1
import { handleCallback as handlePhase1Callback } from "./callbacks.js";
import { handleHelp, handleHoje, handleStart, handleStatus, handleTask, } from "./commands.js";
import { shouldProcess } from "./filter.js";
// Phase 1 redesign — multi-intent
import { extractIntents } from "./multi-intent.js";
import { route, dispatch } from "./router.js";
import { popBatch } from "./batch.js";
// Phase 2
import { handleDM } from "./dm.js";
import { handleWeek, handleWeekCallback, handleWeekTextStep, isAwaitingFocusFor, } from "./week.js";
import { handleFocus } from "./focus.js";
// Phase 3
import { handleRemind } from "./remind.js";
// Phase 5
import { handleToDiscussCommand, handleToDiscussCallback, } from "./todiscuss.js";
import { handleDecisionCallback } from "./decisions.js";
import { handleLaunchCallback } from "./launch.js";
const RECENT_MAX = 6;
const recentByChat = new Map();
const errorLimit = new ErrorRateLimit();
let botInstance = null;
let awaitingAuthCodeFrom = null;
let botInfoUserId = null;
const dedupedUpdates = new Set();
const DEDUPE_MAX = 200;
function pushRecent(chatId, sender, text) {
    const arr = recentByChat.get(chatId) ?? [];
    arr.push({ sender, text });
    while (arr.length > RECENT_MAX)
        arr.shift();
    recentByChat.set(chatId, arr);
}
function getPriors(chatId) {
    const arr = recentByChat.get(chatId) ?? [];
    return arr.slice(0, -1).slice(-5);
}
function dedupe(updateId) {
    if (dedupedUpdates.has(updateId))
        return true;
    dedupedUpdates.add(updateId);
    if (dedupedUpdates.size > DEDUPE_MAX) {
        const first = dedupedUpdates.values().next().value;
        if (first !== undefined)
            dedupedUpdates.delete(first);
    }
    return false;
}
/**
 * Routes inline-button callbacks to the right handler based on the
 * `callback_data` prefix. Phase-1 and Phase-2/5 handlers each own
 * their namespace.
 */
async function callbackRouter(ctx) {
    const data = ctx.callbackQuery?.data;
    if (!data) {
        await ctx.answerCallbackQuery();
        return;
    }
    const [scope] = data.split(":");
    try {
        if (scope === "priority" || scope === "edit") {
            await handlePhase1Callback(ctx);
            return;
        }
        if (scope === "week") {
            const fromId = ctx.from?.id;
            const founder = fromId ? getFounderName(fromId) : null;
            if (!founder) {
                await ctx.answerCallbackQuery();
                return;
            }
            await handleWeekCallback(ctx, founder);
            return;
        }
        if (scope === "todiscuss") {
            await handleToDiscussCallback(ctx);
            return;
        }
        if (scope === "decision") {
            await handleDecisionCallback(ctx);
            return;
        }
        if (scope === "launch") {
            await handleLaunchCallback(ctx);
            return;
        }
        if (scope === "batch") {
            await handleBatchCallback(ctx);
            return;
        }
        log.warn("callback.unknown_scope", { scope, data });
        await ctx.answerCallbackQuery();
    }
    catch (err) {
        log.error("callback.dispatch_failed", { err: String(err), data });
        try {
            await ctx.answerCallbackQuery({ text: "erro — tenta outra vez" });
        }
        catch {
            // already answered
        }
    }
}
export function buildBot() {
    if (botInstance)
        return botInstance;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set");
    }
    const bot = new Bot(token);
    bot.api
        .getMe()
        .then((me) => {
        botInfoUserId = me.id;
        log.info("bot.identified", { username: me.username, id: me.id });
    })
        .catch((err) => log.error("bot.getMe_failed", { err: String(err) }));
    // Welcome on group join.
    bot.on("my_chat_member", async (ctx) => {
        const status = ctx.myChatMember.new_chat_member.status;
        if (status === "member" || status === "administrator") {
            try {
                await ctx.reply(WELCOME_MESSAGE);
            }
            catch (err) {
                log.warn("welcome.send_failed", { err: String(err) });
            }
        }
    });
    // Slash commands (work in both group and DM).
    bot.command("start", handleStart);
    bot.command("help", handleHelp);
    bot.command("task", handleTask);
    bot.command("status", handleStatus);
    bot.command("week", async (ctx) => {
        const fromId = ctx.from?.id;
        const founder = fromId ? getFounderName(fromId) : null;
        if (!founder)
            return;
        await handleWeek(ctx, founder);
    });
    bot.command("focus", async (ctx) => {
        const fromId = ctx.from?.id;
        const founder = fromId ? getFounderName(fromId) : null;
        if (!founder)
            return;
        await handleFocus(ctx, founder, ctx.message?.text ?? "");
    });
    bot.command("remind", handleRemind);
    bot.command("todiscuss", handleToDiscussCommand);
    bot.command("hoje", handleHoje);
    // Google Calendar auth — Madalena's private DM only.
    bot.command("auth", async (ctx) => {
        if (ctx.chat.type !== "private")
            return;
        if (getFounderName(ctx.from?.id ?? 0) !== "Madalena")
            return;
        awaitingAuthCodeFrom = ctx.from.id;
        await ctx.reply("Abre o link, autoriza, copia o valor de code= da barra de endereço e cola aqui:");
        await ctx.reply(calendar.getAuthUrl());
    });
    bot.command("cals", async (ctx) => {
        if (ctx.chat.type !== "private")
            return;
        if (getFounderName(ctx.from?.id ?? 0) !== "Madalena")
            return;
        if (!calendar.isAuthenticated()) {
            await ctx.reply("faz /auth primeiro");
            return;
        }
        try {
            const cals = await calendar.listAllCalendars();
            if (cals.length === 0) {
                await ctx.reply("nenhum calendário encontrado");
                return;
            }
            const lines = cals.map((c) => `• ${c.summary}\n  ID: \`${c.id}\``).join("\n\n");
            await ctx.reply(`Calendários disponíveis:\n\n${lines}\n\nCopia os IDs que queres usar para GOOGLE_CALENDAR_IDS no .env`, { parse_mode: "Markdown" });
        }
        catch (err) {
            log.error("cals.failed", { err: String(err) });
            await ctx.reply("erro a listar calendários");
        }
    });
    // Inline button callbacks.
    bot.on("callback_query:data", callbackRouter);
    // Text message router.
    bot.on("message:text", async (ctx) => {
        if (dedupe(ctx.update.update_id))
            return;
        const fromId = ctx.from?.id;
        if (!fromId || !isFounder(fromId))
            return;
        const senderName = getFounderName(fromId);
        if (!senderName)
            return;
        const text = ctx.message.text;
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        // 1) DM-only wizard step: if founder is mid-/week flow waiting for
        // operational focus text, route there first.
        if (chatType === "private" && isAwaitingFocusFor(fromId)) {
            try {
                await handleWeekTextStep(ctx, senderName, text);
            }
            catch (err) {
                log.error("week.text_step_failed", { err: String(err) });
            }
            return;
        }
        // 2) DM router: any other DM goes through the dedicated handler.
        if (chatType === "private") {
            // Intercept Google Calendar auth code paste.
            if (awaitingAuthCodeFrom === fromId && text.startsWith("4/")) {
                try {
                    await calendar.exchangeCodeForToken(text.trim());
                    awaitingAuthCodeFrom = null;
                    await ctx.reply("✅ Google Calendar autenticado! Usa /cals para ver os teus calendários.");
                }
                catch (err) {
                    log.warn("auth.exchange_failed", { err: String(err) });
                    await ctx.reply("Código inválido. Tenta /auth de novo.");
                }
                return;
            }
            try {
                const handled = await handleDM(ctx);
                if (handled)
                    return;
            }
            catch (err) {
                log.error("dm.unhandled", { err: String(err) });
                return;
            }
        }
        // 3) Group: detect replies to the bot as corrections.
        const repliedTo = ctx.message.reply_to_message;
        const isReplyToBot = botInfoUserId !== null && repliedTo?.from?.id === botInfoUserId;
        if (isReplyToBot) {
            try {
                const { record } = await import("../feedback.js");
                await record("correction", repliedTo?.text ?? "", senderName, { telegram_reply_to: repliedTo?.message_id }, "reply", text);
            }
            catch (err) {
                log.warn("correction.log_failed", { err: String(err) });
            }
            return;
        }
        const hasNonTextMedia = Boolean(ctx.message.photo ||
            ctx.message.video ||
            ctx.message.voice ||
            ctx.message.audio ||
            ctx.message.document ||
            ctx.message.sticker);
        pushRecent(chatId, senderName, text);
        if (!shouldProcess({ text, isReplyToBot: false, hasNonTextMedia })) {
            return;
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
            log.warn("pipeline.context_fetch_failed", { err: String(err) });
        }
        const chatCtx = {
            text,
            sender: senderName,
            recentMessages: getPriors(chatId),
            recentBotActions,
            openTasks,
        };
        try {
            const intents = await extractIntents(chatCtx);
            await route(ctx, chatCtx, intents);
        }
        catch (err) {
            log.error("pipeline.error", { err: String(err) });
            if (errorLimit.tryNotify()) {
                try {
                    await ctx.reply(ERROR_MESSAGE);
                }
                catch (sendErr) {
                    log.warn("error_message.send_failed", { err: String(sendErr) });
                }
            }
        }
    });
    bot.catch((err) => {
        log.error("bot.unhandled", {
            err: err.error instanceof Error ? err.error.message : String(err.error),
        });
    });
    botInstance = bot;
    return bot;
}
async function handleBatchCallback(ctx) {
    const data = ctx.callbackQuery?.data;
    if (!data) {
        await ctx.answerCallbackQuery();
        return;
    }
    const [, action, batchId] = data.split(":");
    if (!action || !batchId) {
        await ctx.answerCallbackQuery();
        return;
    }
    const intents = popBatch(batchId);
    if (!intents) {
        await ctx.answerCallbackQuery({ text: "expirou — manda outra vez" });
        return;
    }
    const fromId = ctx.from?.id;
    if (!fromId || !isFounder(fromId)) {
        await ctx.answerCallbackQuery({ text: "só founders podem confirmar" });
        return;
    }
    const sender = getFounderName(fromId);
    if (!sender) {
        await ctx.answerCallbackQuery();
        return;
    }
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
        await ctx.answerCallbackQuery();
        return;
    }
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    if (action === "cancel") {
        await ctx.answerCallbackQuery();
        await ctx.reply("cancelado");
        return;
    }
    // Build a chatCtx for handlers that need it (REMINDER/LOG/etc.).
    const recentBotActions = await getRecentActions(chatId).catch(() => []);
    const openTasks = await notion.getOpenTasks().catch(() => []);
    const chatCtx = {
        text: "",
        sender,
        recentMessages: [],
        recentBotActions,
        openTasks,
    };
    if (action === "review") {
        await ctx.answerCallbackQuery();
        for (const intent of intents) {
            try {
                await dispatch(ctx, chatCtx, intent);
            }
            catch (err) {
                log.error("batch.review_dispatch_failed", { err: String(err) });
            }
        }
        return;
    }
    if (action === "accept") {
        await ctx.answerCallbackQuery();
        let count = 0;
        for (const intent of intents) {
            try {
                if (intent.type === "NEW_TASK") {
                    // Mass-accept: skip the priority button card; default Média.
                    await notion.createTask({
                        title: intent.title,
                        owner: intent.owner,
                        area: intent.area,
                        why: intent.why,
                    }, "Média", "(batch accept)", sender);
                    count++;
                    continue;
                }
                // For LOG / REMINDER / EDIT_PENDING — auto-commit via dispatch.
                // For EDIT_TASK / DECISION / LAUNCH_INTENT — dispatch posts a confirm card.
                await dispatch(ctx, chatCtx, intent);
                count++;
            }
            catch (err) {
                log.error("batch.accept_dispatch_failed", {
                    type: intent.type,
                    err: String(err),
                });
            }
        }
        await ctx.reply(`feito ✅ — ${count} coisas processadas`);
        return;
    }
    await ctx.answerCallbackQuery();
}
