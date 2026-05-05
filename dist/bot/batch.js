/**
 * Batch-summary UX for messages that produced ≥3 intents.
 *
 * Posts a single card with three buttons:
 *   - aceitar todas (mass-accept; NEW_TASK gets default priority "Média")
 *   - rever uma a uma (falls back to per-card flow)
 *   - cancelar (drops everything)
 *
 * Pending state is stored in memory keyed by a short batch id. We accept
 * loss-on-restart: if the bot redeploys before the user clicks, the card
 * is dead and the user re-sends. Bot Pending DB persistence is overkill
 * for a 30-second decision window.
 */
import { InlineKeyboard } from "grammy";
const MIN_BATCH = 3;
const MAX_BATCHES = 50;
export function isBatch(intents) {
    return intents.length >= MIN_BATCH;
}
const TYPE_LABELS = {
    NEW_TASK: "tarefas novas",
    EDIT_TASK: "edições de tarefa",
    REMINDER: "lembretes",
    LOG: "anotações no log",
    DECISION: "decisões",
    LAUNCH_INTENT: "planos de lançamento",
    EDIT_PENDING: "correções",
    SET_DEPENDENCY: "dependências",
    TO_DISCUSS: "tópicos para discutir",
    CREATE_ENTITY: "entidades criadas",
};
export function summarize(intents) {
    const counts = new Map();
    for (const i of intents) {
        counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
    }
    const lines = [`Vi ${intents.length} coisas aqui:`];
    for (const [type, count] of counts) {
        lines.push(`• ${count} ${TYPE_LABELS[type]}`);
    }
    return lines.join("\n");
}
export function batchKeyboard(batchId) {
    return new InlineKeyboard()
        .text("✅ aceitar todas", `batch:accept:${batchId}`)
        .text("👀 rever uma a uma", `batch:review:${batchId}`)
        .row()
        .text("❌ cancelar", `batch:cancel:${batchId}`);
}
const batches = new Map();
export function storeBatch(intents) {
    const id = `b${Date.now().toString(36)}`;
    batches.set(id, intents);
    while (batches.size > MAX_BATCHES) {
        const first = batches.keys().next().value;
        if (first !== undefined)
            batches.delete(first);
    }
    return id;
}
export function popBatch(id) {
    const intents = batches.get(id);
    if (!intents)
        return null;
    batches.delete(id);
    return intents;
}
export async function postBatchCard(ctx, intents) {
    const id = storeBatch(intents);
    await ctx.reply(summarize(intents), { reply_markup: batchKeyboard(id) });
}
