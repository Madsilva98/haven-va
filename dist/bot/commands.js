/**
 * Slash commands: /help, /start, /task <descrição>, /status, /hoje, /dashboard.
 *
 * /task creates a task directly in Notion without going through the AI pipeline.
 */
import * as calendar from "../lib/calendar.js";
import { getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { HELP_MESSAGE } from "../messages/help.js";
import { WELCOME_MESSAGE } from "../messages/welcome.js";
import { escapeMd, formatHoje, rankTasks } from "../messages/cycle.js";
import { formatDashboard } from "../messages/dashboard.js";
import * as notion from "../notion.js";
import { currentWeekLabel } from "../lib/week.js";
import { buildFreeTimeDesc } from "../crons/daily-madalena.js";
import { taskUndoKeyboard } from "./keyboards.js";
import { handleAssistant } from "./assistant.js";
// Keywords that signal compound intent in /task — route to assistant instead of fast path.
const COMPOUND_TASK_RE = /\b(reminder|lembrete|avisa|aviso|todos\s+os\s+dias|toda\s+a\s+semana|todo\s+o\s+m[eê]s|diariamente|semanalmente|mensalmente|no\s+projeto|ao\s+projeto|do\s+projeto|no\s+parceiro|ao\s+parceiro|no\s+evento|ao\s+evento|ao\s+influencer|prioridade\s+alta|urgente)\b/i;
export async function handleStart(ctx) {
    await ctx.reply(WELCOME_MESSAGE);
}
export async function handleHelp(ctx) {
    await ctx.reply(HELP_MESSAGE);
}
export async function handleTask(ctx) {
    const fullText = ctx.message?.text ?? "";
    const description = fullText.replace(/^\/task(@\w+)?\s*/i, "").trim();
    if (!description) {
        await ctx.reply("usa `/task <descrição>` para forçar uma task", {
            parse_mode: "Markdown",
        });
        return;
    }
    const senderId = ctx.from?.id;
    if (!senderId)
        return;
    const senderName = getFounderName(senderId);
    if (!senderName)
        return;
    // Compound intent detected — route to assistant for full interpretation.
    if (COMPOUND_TASK_RE.test(description)) {
        try {
            await handleAssistant(ctx, senderName, `cria uma task: ${description}`, [], undefined, undefined, undefined);
        }
        catch (err) {
            log.error("commands.task.assistant_failed", { err: String(err) });
            await ctx.reply("erro a processar — tenta outra vez");
        }
        return;
    }
    // Fast path — plain task, no AI needed.
    try {
        const pageId = await notion.createTask({
            title: description.slice(0, 80),
            owner: "Unassigned",
            area: "Outro",
            why: "levantado via /task",
        }, "2. Média", description, senderName);
        await ctx.reply(`✅ task criada: "${description.slice(0, 80)}"`, {
            reply_markup: taskUndoKeyboard(pageId),
        });
    }
    catch (err) {
        log.error("commands.task.failed", { err: String(err) });
        await ctx.reply("erro a criar task — tenta outra vez");
    }
}
export async function handleHoje(ctx) {
    const fromId = ctx.from?.id;
    const sender = fromId ? getFounderName(fromId) : null;
    if (!sender)
        return;
    const arg = (ctx.message?.text ?? "")
        .replace(/^\/hoje(@\w+)?\s*/i, "")
        .trim()
        .toLowerCase();
    const nameMap = {
        madalena: "Madalena",
        mafalda: "Mafalda",
        beatriz: "Beatriz",
        bia: "Beatriz",
    };
    const target = (arg ? nameMap[arg] : undefined) ?? sender;
    try {
        const tasks = await notion.getOpenTasksFor(target);
        const ranked = rankTasks(tasks);
        let calDesc = "";
        if (target === "Madalena" && calendar.isAuthenticated()) {
            const events = await calendar.listEventsToday();
            calDesc = buildFreeTimeDesc(events);
        }
        const text = formatHoje({ target, tasks: ranked, calDesc });
        await ctx.reply(text, { parse_mode: "MarkdownV2" });
    }
    catch (err) {
        log.error("commands.hoje.failed", { err: String(err) });
        await ctx.reply("erro a buscar tasks — tenta outra vez");
    }
}
export async function handleLista(ctx) {
    const arg = (ctx.message?.text ?? "")
        .replace(/^\/lista(@\w+)?\s*/i, "")
        .trim();
    try {
        const items = await notion.getList(arg || undefined);
        if (items.length === 0) {
            const msg = arg ? `lista *${arg}* está vazia` : "não há itens em nenhuma lista";
            await ctx.reply(msg, { parse_mode: "Markdown" });
            return;
        }
        if (!arg) {
            // Aggregate: show list names with pending counts
            const counts = new Map();
            for (const i of items) {
                if (!i.feito)
                    counts.set(i.lista, (counts.get(i.lista) ?? 0) + 1);
            }
            const lines = ["📋 *Listas*"];
            for (const [nome, count] of counts) {
                lines.push(`  • ${nome} — ${count} item${count !== 1 ? "s" : ""} por fazer`);
            }
            await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
            return;
        }
        const pending = items.filter((i) => !i.feito);
        const done = items.filter((i) => i.feito);
        const lines = [`📋 *${arg}*`];
        for (const i of pending)
            lines.push(`  ☐ ${i.item}`);
        if (done.length > 0) {
            lines.push("");
            for (const i of done)
                lines.push(`  ☑ ~${i.item}~`);
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    }
    catch (err) {
        log.error("commands.lista.failed", { err: String(err) });
        await ctx.reply("erro a carregar lista — tenta outra vez");
    }
}
export async function handleDashboard(ctx) {
    try {
        const [focus, toDiscuss] = await Promise.all([
            notion.getFounderFocusForWeek(currentWeekLabel()),
            notion.getToDiscussPending(),
        ]);
        const text = formatDashboard({ focus, toDiscuss });
        await ctx.reply(text, { parse_mode: "MarkdownV2" });
    }
    catch (err) {
        log.error("commands.dashboard.failed", { err: String(err) });
        await ctx.reply("erro a carregar dashboard — tenta outra vez");
    }
}
// ----- Entity dashboards -----
const ENTITY_FIELDS = {
    projects: "Projects",
    partners: "Partner Pipeline",
    events: "Events Pipeline",
    influencers: "Influencer Pipeline",
};
async function handleEntityCommand(ctx, dbKey, label) {
    const fromId = ctx.from?.id;
    const sender = fromId ? getFounderName(fromId) : null;
    if (!sender)
        return;
    try {
        const entities = await notion.getEntitiesForOwner(dbKey, sender);
        if (entities.length === 0) {
            await ctx.reply(`nenhum ${label} em aberto para ${sender}`);
            return;
        }
        const capped = entities.slice(0, 8);
        const entityField = ENTITY_FIELDS[dbKey] ?? dbKey;
        const taskGroups = await Promise.all(capped.map((e) => notion.getTasksForEntity(entityField, e.id)));
        const lines = [`*${escapeMd(label)} — ${escapeMd(sender)}*`];
        for (let i = 0; i < capped.length; i++) {
            const e = capped[i];
            const tasks = taskGroups[i];
            lines.push("");
            const statusStr = e.status ? ` \\(${escapeMd(e.status)}\\)` : "";
            lines.push(`• *${escapeMd(e.name)}*${statusStr}`);
            for (const t of tasks) {
                lines.push(`  ↳ ${escapeMd(t.title)}`);
            }
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    }
    catch (err) {
        log.error(`commands.${dbKey}.failed`, { err: String(err) });
        await ctx.reply(`erro a carregar ${label} — tenta outra vez`);
    }
}
export async function handleProjects(ctx) {
    await handleEntityCommand(ctx, "projects", "projetos");
}
export async function handlePartners(ctx) {
    await handleEntityCommand(ctx, "partners", "parceiros");
}
export async function handleEvents(ctx) {
    await handleEntityCommand(ctx, "events", "eventos");
}
export async function handleInfluencers(ctx) {
    await handleEntityCommand(ctx, "influencers", "influencers");
}
// ----- Calendar & Content -----
const dayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" });
const timeFormatter = new Intl.DateTimeFormat("pt-PT", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Lisbon",
});
export async function handleCalendar(ctx) {
    if (!calendar.isAuthenticated()) {
        await ctx.reply("calendário Google não configurado — faz /auth primeiro");
        return;
    }
    try {
        const now = new Date();
        const todayStr = dayFormatter.format(now);
        const day2 = dayFormatter.format(new Date(now.getTime() + 86_400_000));
        const day3 = dayFormatter.format(new Date(now.getTime() + 2 * 86_400_000));
        const endStr = dayFormatter.format(new Date(now.getTime() + 3 * 86_400_000));
        const dayLabels = {
            [todayStr]: "hoje",
            [day2]: "amanhã",
            [day3]: "depois de amanhã",
        };
        const events = await calendar.listEvents(3);
        const relevant = events.filter((e) => {
            const d = dayFormatter.format(e.start);
            return d >= todayStr && d < endStr;
        });
        if (relevant.length === 0) {
            await ctx.reply(escapeMd("nada nos próximos 3 dias"), { parse_mode: "MarkdownV2" });
            return;
        }
        const groups = new Map();
        for (const e of relevant) {
            const d = dayFormatter.format(e.start);
            const g = groups.get(d) ?? [];
            g.push(e);
            groups.set(d, g);
        }
        const lines = ["*calendário — próximos 3 dias*"];
        for (const dayStr of [todayStr, day2, day3]) {
            const group = groups.get(dayStr);
            if (!group?.length)
                continue;
            lines.push("");
            lines.push(`📅 *${escapeMd(dayLabels[dayStr] ?? dayStr)}*`);
            for (const e of group) {
                const timeStr = e.allDay ? "todo o dia" : timeFormatter.format(e.start);
                lines.push(`  ${escapeMd(timeStr)} ${escapeMd(e.title)}`);
            }
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    }
    catch (err) {
        log.error("commands.calendar.failed", { err: String(err) });
        await ctx.reply("erro a carregar calendário — tenta outra vez");
    }
}
export async function handleContent(ctx) {
    try {
        const rows = await notion.getContentCalendarRows();
        const now = new Date();
        const todayStr = dayFormatter.format(now);
        const endStr = dayFormatter.format(new Date(now.getTime() + 3 * 86_400_000));
        const upcoming = rows
            .filter((r) => r.publishDate && r.publishDate >= todayStr && r.publishDate < endStr)
            .sort((a, b) => (a.publishDate ?? "").localeCompare(b.publishDate ?? ""));
        if (upcoming.length === 0) {
            await ctx.reply(escapeMd("nada planeado nos próximos 3 dias"), { parse_mode: "MarkdownV2" });
            return;
        }
        const lines = ["*content — próximos 3 dias*"];
        for (const r of upcoming) {
            lines.push("");
            const typeStr = r.platform ? ` \\[${escapeMd(r.platform)}\\]` : "";
            const statusStr = r.status ? ` \\(${escapeMd(r.status)}\\)` : "";
            lines.push(`📱 ${escapeMd(r.publishDate ?? "?")}${typeStr}${statusStr}`);
            lines.push(`  ${escapeMd(r.title)}`);
        }
        await ctx.reply(lines.join("\n"), { parse_mode: "MarkdownV2" });
    }
    catch (err) {
        log.error("commands.content.failed", { err: String(err) });
        await ctx.reply("erro a carregar content calendar — tenta outra vez");
    }
}
