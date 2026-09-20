/**
 * Telegram MarkdownV2 templates for the Phase 2 weekly cycle messages.
 *
 * All copy is pt-PT, "tu" register, lowercase preferred. No marketing
 * speak. Templates are pure functions of structured data so they can
 * be unit-tested without hitting Telegram or Notion.
 */
/**
 * Escape characters reserved by Telegram MarkdownV2.
 * Per the Bot API docs, these chars must be backslash-escaped in any
 * text placed inside a MarkdownV2 message:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMd(s) {
    return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}
function fmtTask(t) {
    const title = escapeMd(t.title);
    const owner = escapeMd(t.owner);
    const parts = [owner];
    if (t.priority)
        parts.push(escapeMd(t.priority.toLowerCase()));
    if (t.deadline)
        parts.push(escapeMd(t.deadline));
    return `• ${title} \\(${parts.join(", ")}\\)`;
}
function fmtTaskNoOwner(t) {
    const title = escapeMd(t.title);
    const parts = [];
    if (t.priority)
        parts.push(escapeMd(t.priority.toLowerCase()));
    if (t.deadline)
        parts.push(escapeMd(t.deadline));
    const tail = parts.length ? ` \\(${parts.join(", ")}\\)` : "";
    return `• ${title}${tail}`;
}
// 🟢 Feito, 🟡 Em curso, 🔴 To do (as asked) — ⚪ covers Cancelado, which
// wasn't part of the spec and doesn't read as "still outstanding".
function statusEmoji(status) {
    switch (status) {
        case "Feito":
            return "🟢";
        case "Em curso":
            return "🟡";
        case "To do":
            return "🔴";
        default:
            return "⚪";
    }
}
function fmtTaskColored(t) {
    const title = escapeMd(t.title);
    const tail = t.deadline ? ` \\(${escapeMd(t.deadline)}\\)` : "";
    return `${statusEmoji(t.status)} ${title}${tail}`;
}
export function formatFridayBalance(args) {
    const lines = [];
    lines.push(`*balanço de sexta — ${escapeMd(args.weekLabel)}*`);
    lines.push("");
    const founders = ["Madalena", "Mafalda", "Beatriz"];
    const focusMap = new Map();
    for (const f of args.focus)
        focusMap.set(f.founder, f.focoOperacional);
    for (const founder of founders) {
        const tasks = args.prioritiesByFounder[founder] ?? [];
        const focus = focusMap.get(founder);
        if (tasks.length === 0 && !focus)
            continue;
        lines.push(`*${escapeMd(founder)}*`);
        if (focus) {
            lines.push(`_foco_: ${escapeMd(focus)}`);
        }
        if (tasks.length === 0) {
            lines.push(escapeMd("(sem prioridades marcadas)"));
        }
        else {
            for (const t of tasks)
                lines.push(fmtTaskColored(t));
        }
        lines.push("");
    }
    lines.push(`*feito esta semana \\(${args.completed.length}\\)*`);
    if (args.completed.length === 0) {
        lines.push(escapeMd("nada fechado ainda"));
    }
    else {
        for (const t of args.completed.slice(0, 15))
            lines.push(fmtTask(t));
        if (args.completed.length > 15) {
            lines.push(escapeMd(`... +${args.completed.length - 15} outras`));
        }
    }
    lines.push("");
    lines.push(`*atrasadas \\(${args.overdue.length}\\)*`);
    if (args.overdue.length === 0) {
        lines.push(escapeMd("nenhuma — boa"));
    }
    else {
        for (const t of args.overdue.slice(0, 10))
            lines.push(fmtTask(t));
        if (args.overdue.length > 10) {
            lines.push(escapeMd(`... +${args.overdue.length - 10} outras`));
        }
    }
    return lines.join("\n");
}
export function formatMondayPriorities(args) {
    const lines = [];
    lines.push(`*segunda — ${escapeMd(args.weekLabel)}*`);
    lines.push("");
    lines.push(escapeMd("aqui vai o plano da semana:"));
    lines.push("");
    const founders = ["Madalena", "Mafalda", "Beatriz"];
    const focusMap = new Map();
    for (const f of args.focus)
        focusMap.set(f.founder, f.focoOperacional);
    for (const founder of founders) {
        const tasks = args.prioritiesByFounder[founder] ?? [];
        const focus = focusMap.get(founder);
        if (tasks.length === 0 && !focus)
            continue;
        lines.push(`*${escapeMd(founder)}*`);
        if (focus) {
            lines.push(`_foco_: ${escapeMd(focus)}`);
        }
        if (tasks.length === 0) {
            lines.push(escapeMd("(sem prioridades marcadas — usa /week)"));
        }
        else {
            for (const t of tasks)
                lines.push(fmtTaskNoOwner(t));
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
export function formatDailyMadalenaPlaceholder(args) {
    const lines = [];
    lines.push("*as tuas tasks abertas*");
    lines.push("");
    if (args.tasks.length === 0) {
        lines.push(escapeMd("nada no backlog — descansa um bocado"));
        return lines.join("\n");
    }
    for (const t of args.tasks.slice(0, 10)) {
        lines.push(fmtTaskNoOwner(t));
    }
    if (args.tasks.length > 10) {
        lines.push(escapeMd(`... +${args.tasks.length - 10} outras`));
    }
    return lines.join("\n");
}
export function formatWeeklyPriorities(args) {
    const lines = [];
    lines.push(`*prioridades semanais — ${escapeMd(args.founder)}*`);
    lines.push("");
    if (args.tasks.length === 0) {
        lines.push(escapeMd('nenhuma task marcada como prioridade semanal. usa o botão "📌 Prioridade semanal" ao criar uma task com /task.'));
        return lines.join("\n");
    }
    for (const t of args.tasks) {
        lines.push(`${fmtTaskNoOwner(t)} — _${escapeMd(t.status)}_`);
    }
    return lines.join("\n");
}
