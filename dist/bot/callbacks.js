/**
 * Inline-button callback handler.
 *
 * Routes:
 *   task:undo:<pageId>          → archive a directly-created task (no pending state)
 *   priority:alta|media|baixa  → confirm a NEW_TASK proposal with chosen priority
 *   priority:cancel            → drop a NEW_TASK proposal as false positive
 *   edit:apply                 → apply an EDIT_TASK to Notion
 *   edit:cancel                → drop an EDIT_TASK proposal as false positive
 */
import { isFounder, getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { confirmationMessages } from "../messages/errors.js";
import * as notion from "../notion.js";
import { record } from "../feedback.js";
import { getPending, commitPending, cancelPending } from "../state/pending.js";
import { checkAndUnblockDependents } from "./dependencies.js";
export async function handleCallback(ctx) {
    const query = ctx.callbackQuery;
    if (!query)
        return;
    const data = query.data;
    const userId = query.from.id;
    const message = query.message;
    const botMessageId = message?.message_id;
    if (!data || botMessageId === undefined) {
        await ctx.answerCallbackQuery();
        return;
    }
    if (!isFounder(userId)) {
        await ctx.answerCallbackQuery({ text: "só founders podem confirmar" });
        return;
    }
    const parts = data.split(":");
    const scope = parts[0];
    const action = parts[1];
    // task:undo:pageId — archive directly, no pending state needed.
    // answerCallbackQuery FIRST so Telegram doesn't show infinite loading
    // if any subsequent Notion/Telegram call is slow or fails.
    if (scope === "task" && action === "undo") {
        const pageId = parts.slice(2).join(":");
        await ctx.answerCallbackQuery();
        try {
            await notion.archivePage(pageId);
            notion.invalidateOpenTasksCache();
        }
        catch (err) {
            log.error("callback.undo_archive_failed", { err: String(err), pageId });
            await ctx.reply("erro ao desfazer — tenta outra vez");
            return;
        }
        try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        }
        catch {
            // message may be too old to edit — ignore
        }
        await ctx.reply("↩ task removida");
        return;
    }
    // Remaining handlers need senderName + pending proposal
    const senderName = getFounderName(userId);
    if (!senderName) {
        await ctx.answerCallbackQuery();
        return;
    }
    const proposal = await getPending(botMessageId);
    if (!proposal) {
        await ctx.answerCallbackQuery({ text: confirmationMessages.pendingExpired() });
        return;
    }
    try {
        if (scope === "edit" && proposal.type === "edit") {
            if (action === "cancel") {
                await record("false_positive", proposal.originalMsg, senderName, proposal.extraction, "❌ deixa");
                await cancelPending(botMessageId);
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
                await ctx.reply(confirmationMessages.editIgnored(), {
                    reply_parameters: { message_id: botMessageId },
                });
                await ctx.answerCallbackQuery();
                return;
            }
            if (action === "apply") {
                await notion.updateTask(proposal.extraction.targetTaskId, proposal.extraction.field, proposal.extraction.newValue);
                if (proposal.extraction.field === "status" &&
                    proposal.extraction.newValue === "Feito") {
                    await checkAndUnblockDependents(proposal.extraction.targetTaskId, proposal.extraction.targetTitle);
                }
                notion.invalidateOpenTasksCache();
                await record("confirmed", proposal.originalMsg, senderName, proposal.extraction, "✅ atualiza");
                await commitPending(botMessageId, proposal.extraction.targetTaskId);
                await ctx.editMessageReplyMarkup({ reply_markup: undefined });
                await ctx.reply(confirmationMessages.editApplied(), {
                    reply_parameters: { message_id: botMessageId },
                });
                await ctx.answerCallbackQuery();
                return;
            }
        }
        // Mismatched scope/proposal type — ignore quietly.
        await ctx.answerCallbackQuery();
    }
    catch (err) {
        log.error("callback.error", { err: String(err), data, botMessageId });
        await ctx.answerCallbackQuery({ text: "erro — tenta outra vez" });
    }
}
