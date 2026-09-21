/**
 * Telegram surface for the studio's pulse_cases ledger (spec
 * docs/plans/2026-09-21-pulse-views-spec.md, steps 3-4):
 *   /flag <texto>  — "this number is wrong", recorded as an open case
 *   /casos         — what's open
 *   "porquê?"      — the COMMENT of the view the last number came from
 */
import { getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { formatCasosList, insertPulseCase, listOpenCases } from "../lib/pulse-cases.js";
import { extractViewsFromText, lastSource } from "../lib/pulse-source.js";
import { getColumnComments, getViewComment } from "../lib/pulse-views.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { lisbonDateString } from "../lib/tz.js";
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
function commandPayload(text, command) {
    return (text ?? "").replace(new RegExp(`^/${command}(@\\w+)?\\s*`, "i"), "").trim();
}
export async function handleFlag(ctx) {
    const founder = getFounderName(ctx.from?.id ?? 0);
    if (!founder || !ctx.chat)
        return;
    const text = commandPayload(ctx.message?.text, "flag");
    if (!text) {
        await ctx.reply("Uso: /flag <o que está errado> — ex.: /flag a Esen aparece como activa mas está em pausa");
        return;
    }
    if (!isStudioDbAvailable()) {
        await ctx.reply("Supabase do estúdio não configurado — não consigo registar o caso.");
        return;
    }
    // The view named in the message being replied to wins; else the last
    // one the bot named in this chat.
    const replied = extractViewsFromText(ctx.message?.reply_to_message?.text);
    const views = replied.length > 0 ? replied : lastSource(ctx.chat.id);
    try {
        const id = await insertPulseCase({
            raisedBy: founder.toLowerCase(),
            source: "telegram",
            subject: text,
            observed: text,
            expected: "por confirmar no Kenko",
            viewName: views[0] ?? null,
            evidence: `Telegram /flag por ${founder}, ${lisbonDateString(new Date())}`,
        });
        await ctx.reply(`Registado como caso #${id}${views[0] ? ` (${views[0]})` : ""}. A Mafalda vê-o em v_pulse_known_cases.`);
    }
    catch (err) {
        log.error("pulse.flag_failed", { message: errMsg(err) });
        await ctx.reply("erro a registar o caso — tenta outra vez");
    }
}
export async function handleCasos(ctx) {
    if (!getFounderName(ctx.from?.id ?? 0))
        return;
    if (!isStudioDbAvailable()) {
        await ctx.reply("Supabase do estúdio não configurado.");
        return;
    }
    try {
        await ctx.reply(formatCasosList(await listOpenCases()));
    }
    catch (err) {
        log.error("pulse.casos_failed", { message: errMsg(err) });
        await ctx.reply("erro a ler os casos — tenta outra vez");
    }
}
/**
 * "porquê?" → the COMMENT of the view named in the replied-to message, else
 * the last one named in this chat, plus the column comments that carry a
 * rule of their own (next_charge_on, last_visit, pause_days_est, …). Read
 * live over the bot's own connection (obj_description / col_description on
 * the va.* mirror). Returns false when nothing was named, so the assistant
 * answers instead.
 */
export async function handleWhy(ctx, repliedToText) {
    if (!ctx.chat)
        return false;
    const replied = extractViewsFromText(repliedToText);
    const views = replied.length > 0 ? replied : lastSource(ctx.chat.id);
    if (views.length === 0)
        return false;
    if (!isStudioDbAvailable()) {
        await ctx.reply("Supabase do estúdio não configurado — não consigo ler a regra.");
        return true;
    }
    const parts = [];
    for (const view of views) {
        try {
            const [comment, columns] = await Promise.all([getViewComment(view), getColumnComments(view)]);
            const lines = [comment ? `${view}:\n${comment}` : `${view}: ainda sem descrição na base de dados.`];
            for (const c of columns)
                lines.push(`• ${c.column}: ${c.comment}`);
            parts.push(lines.join("\n"));
        }
        catch (err) {
            log.warn("pulse.why_comment_failed", { view, message: errMsg(err) });
            parts.push(`${view}: não consegui ler a descrição agora.`);
        }
    }
    await ctx.reply(parts.join("\n\n"));
    return true;
}
