/**
 * `/focus <text>` — single-shot operational focus setter.
 *
 * Upserts the founder's row in the Founder Focus DB for the current
 * week. Useful when the founder skipped the `/week` wizard's last
 * step or wants to update the focus mid-week.
 */
import { log } from "../lib/log.js";
import { currentWeekLabel } from "../lib/week.js";
import * as notion from "../notion.js";
export function isFocusCommand(text) {
    return /^\/focus(@\w+)?(\s|$)/i.test(text);
}
export async function handleFocus(ctx, founder, text) {
    const focus = text.replace(/^\/focus(@\w+)?\s*/i, "").trim();
    if (focus.length === 0) {
        await ctx.reply("usa `/focus <frase>` para definires o foco da semana", {
            parse_mode: "Markdown",
        });
        return;
    }
    try {
        await notion.setFounderFocus({
            founder,
            semana: currentWeekLabel(),
            focoOperacional: focus,
        });
    }
    catch (err) {
        log.error("focus.save_failed", { err: String(err) });
        await ctx.reply("não consegui guardar — tenta outra vez");
        return;
    }
    await ctx.reply(`foco da semana guardado: ${focus}`);
}
