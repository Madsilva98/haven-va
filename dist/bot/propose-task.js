/**
 * NEW_TASK handler — creates the task immediately, shows confirmation
 * with an [↩ Desfazer] button. No priority keyboard needed.
 */
import { record } from "../feedback.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import { addPending, commitPending } from "../state/pending.js";
import { taskUndoKeyboard } from "./keyboards.js";
const PRIORITY_EMOJI = {
    Alta: "🔴",
    Média: "🟡",
    Baixa: "🟢",
};
function esc(v) {
    return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
export async function proposeNewTask(tgCtx, chatCtx, intent) {
    const chatId = tgCtx.chat?.id;
    const replyToMessageId = tgCtx.message?.message_id;
    if (chatId === undefined)
        return;
    const priority = intent.priority ?? "Média";
    const ownerName = intent.owner === "Unassigned" ? null : intent.owner;
    const ownerId = ownerName ? getTelegramId(ownerName) : null;
    const extraction = {
        title: intent.title,
        owner: intent.owner,
        area: intent.area,
        why: intent.why,
    };
    let createdPageId;
    try {
        createdPageId = await notion.createTask(extraction, priority, chatCtx.text, chatCtx.sender, intent.entityRef);
        notion.invalidateOpenTasksCache();
    }
    catch (err) {
        log.error("propose_task.create_failed", { err: String(err) });
        await tgCtx.reply("erro a criar task — tenta outra vez");
        return;
    }
    record("confirmed", chatCtx.text, chatCtx.sender, extraction, `auto:${priority}`).catch((err) => log.warn("propose_task.record_failed", { err: String(err) }));
    const ownerLabel = intent.owner === "Unassigned" || !ownerId
        ? esc(intent.owner === "Unassigned" ? "sem owner" : intent.owner)
        : `<a href="tg://user?id=${ownerId}">${esc(intent.owner)}</a>`;
    const entityLine = intent.entityRef
        ? `\n🔗 ${intent.entityRef.kind}: ${esc(intent.entityRef.nome)}`
        : "";
    const text = `✅ task criada\n\n` +
        `<b>${esc(intent.title)}</b>\n` +
        `📁 ${esc(intent.area)} · ${ownerLabel} · ${PRIORITY_EMOJI[priority]} ${priority}${entityLine}`;
    const sent = await tgCtx.reply(text, {
        parse_mode: "HTML",
        reply_markup: taskUndoKeyboard(createdPageId),
        ...(replyToMessageId !== undefined
            ? { reply_parameters: { message_id: replyToMessageId } }
            : {}),
    });
    await addPending({
        type: "new_task",
        botMessageId: sent.message_id,
        extraction,
        originalMsg: chatCtx.text,
        originalSender: chatCtx.sender,
        createdAt: Date.now(),
    }, chatId);
    commitPending(sent.message_id, createdPageId).catch((err) => log.warn("propose_task.commit_failed", { err: String(err) }));
}
