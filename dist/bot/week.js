/**
 * `/week` — read-only list of the founder's tasks currently marked
 * "Prioridade semanal". Marking/unmarking happens via /task's
 * inline button (see keyboards.ts / callbacks.ts); this command only
 * displays the current picks.
 */
import { log } from "../lib/log.js";
import { currentWeekLabel } from "../lib/week.js";
import * as notion from "../notion.js";
import { formatWeeklyPriorities } from "../messages/cycle.js";
export function isWeekCommand(text) {
    return /^\/week(@\w+)?\b/i.test(text);
}
export async function handleWeek(ctx, founder) {
    try {
        const all = await notion.getWeeklyPriorities(currentWeekLabel());
        const tasks = all.filter((t) => t.owner === founder);
        const text = formatWeeklyPriorities({ founder, tasks });
        await ctx.reply(text, { parse_mode: "MarkdownV2" });
    }
    catch (err) {
        log.error("week.list_failed", { err: String(err) });
        await ctx.reply("erro a carregar prioridades semanais — tenta outra vez");
    }
}
