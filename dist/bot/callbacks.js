/**
 * Inline-button callback handler.
 *
 * Routes:
 *   task:undo:<pageId>               → archive a directly-created task
 *   task:edit_undo:<pageId>:<field>:<oldValue> → revert an update_task action
 */
import { isFounder } from "../lib/founders.js";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
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
    // task:undo:pageId — archive directly-created task
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
    // task:edit_undo:pageId:field:oldValue — revert an update_task action
    if (scope === "task" && action === "edit_undo") {
        const pageId = parts[2];
        const field = parts[3];
        const oldValue = parts.slice(4).join(":");
        await ctx.answerCallbackQuery();
        if (!pageId || !field || !oldValue)
            return;
        try {
            await notion.updateTask(pageId, field, oldValue);
        }
        catch (err) {
            log.error("callback.edit_undo_failed", { err: String(err), pageId, field });
            await ctx.reply("erro ao desfazer — tenta outra vez");
            return;
        }
        try {
            await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        }
        catch {
            // message may be too old to edit — ignore
        }
        await ctx.reply("↩ edição desfeita");
        return;
    }
    await ctx.answerCallbackQuery();
}
