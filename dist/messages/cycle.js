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
function indent(line) {
    return `  ${line}`;
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
function groupByOwner(tasks) {
    const map = new Map();
    for (const t of tasks) {
        const key = t.owner;
        const arr = map.get(key) ?? [];
        arr.push(t);
        map.set(key, arr);
    }
    return map;
}
export function formatFridayBalance(args) {
    const lines = [];
    lines.push(`*balanço de sexta — ${escapeMd(args.weekLabel)}*`);
    lines.push("");
    // Foco operacional definido por cada uma
    if (args.focus.length > 0) {
        lines.push("*foco da semana*");
        for (const f of args.focus) {
            lines.push(`• ${escapeMd(f.founder)}: ${escapeMd(f.focoOperacional)}`);
        }
        lines.push("");
    }
    lines.push("*prioridades semanais*");
    if (args.priorities.length === 0) {
        lines.push(escapeMd("(ninguém marcou prioridades esta semana)"));
    }
    else {
        for (const t of args.priorities)
            lines.push(fmtTask(t));
    }
    lines.push("");
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
export function formatWeekendBrief(args) {
    const lines = [];
    lines.push(`*preparação para a reunião — ${escapeMd(args.weekLabel)}*`);
    lines.push("");
    lines.push("*foco operacional desta semana*");
    if (args.focusByFounder.length === 0) {
        lines.push(escapeMd("(ninguém escreveu foco)"));
    }
    else {
        for (const f of args.focusByFounder) {
            lines.push(`• ${escapeMd(f.founder)}: ${escapeMd(f.focoOperacional)}`);
        }
    }
    lines.push("");
    lines.push(`*por fechar \\(${args.openTasks.length}\\)*`);
    if (args.openTasks.length === 0) {
        lines.push(escapeMd("nada — backlog limpo"));
    }
    else {
        const grouped = groupByOwner(args.openTasks);
        for (const [owner, tasks] of grouped) {
            lines.push(`_${escapeMd(owner)}_`);
            for (const t of tasks.slice(0, 8))
                lines.push(indent(fmtTaskNoOwner(t)));
            if (tasks.length > 8) {
                lines.push(indent(escapeMd(`... +${tasks.length - 8} outras`)));
            }
        }
    }
    if (args.toDiscuss && args.toDiscuss.length > 0) {
        lines.push("");
        lines.push("*para discutir*");
        for (const td of args.toDiscuss) {
            lines.push(`• ${escapeMd(td.tema)} — ${escapeMd(td.adicionadoPor)}`);
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
// ----- Task ranking + traffic lights (shared by daily DM and /hoje) -----
const PRIORITY_RANK = { "1. alta": 0, "2. média": 1, "3. baixa": 2 };
export function rankTasks(tasks) {
    return [...tasks].sort((a, b) => {
        const pa = a.priority ? (PRIORITY_RANK[a.priority] ?? 3) : 3;
        const pb = b.priority ? (PRIORITY_RANK[b.priority] ?? 3) : 3;
        if (pa !== pb)
            return pa - pb;
        const da = a.deadline ?? "9999-12-31";
        const db = b.deadline ?? "9999-12-31";
        return da < db ? -1 : da > db ? 1 : 0;
    });
}
export function trafficLight(task) {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });
    if (task.priority === "1. alta" || task.deadline === today)
        return "red";
    if (task.deadline) {
        const daysUntil = Math.ceil((new Date(task.deadline).getTime() - new Date(today).getTime()) /
            (1000 * 60 * 60 * 24));
        if (daysUntil < 0)
            return "red";
        if (task.priority === "2. média" || daysUntil <= 3)
            return "yellow";
    }
    else if (task.priority === "2. média") {
        return "yellow";
    }
    return "green";
}
const LIGHT_EMOJI = {
    red: "🔴",
    yellow: "🟡",
    green: "🟢",
};
function fmtTrafficTask(t) {
    const light = LIGHT_EMOJI[trafficLight(t)];
    const title = escapeMd(t.title);
    const parts = [];
    if (t.priority)
        parts.push(escapeMd(t.priority.toLowerCase()));
    if (t.deadline)
        parts.push(escapeMd(t.deadline));
    const tail = parts.length ? ` \\(${parts.join(", ")}\\)` : "";
    return `${light} ${title}${tail}`;
}
export function formatDailyDM(args) {
    const lines = [];
    if (args.calDesc) {
        lines.push(`Bom dia\\! ${escapeMd(args.calDesc)}\\.`);
        lines.push("");
    }
    else {
        lines.push(`Bom dia, ${escapeMd(args.founder)}\\!`);
        lines.push("");
    }
    if (args.tasks.length === 0) {
        lines.push(escapeMd("nada no backlog — descansa um bocado"));
        return lines.join("\n");
    }
    const reds = args.tasks.filter((t) => trafficLight(t) === "red");
    const yellows = args.tasks.filter((t) => trafficLight(t) === "yellow");
    const greens = args.tasks.filter((t) => trafficLight(t) === "green");
    const shown = [...reds, ...yellows, ...greens].slice(0, 5);
    for (const t of shown) {
        if (trafficLight(t) === "green") {
            lines.push(`🟢 ${escapeMd("Se sobrar tempo:")} ${escapeMd(t.title)}`);
        }
        else {
            lines.push(fmtTrafficTask(t));
        }
    }
    return lines.join("\n");
}
export function formatHoje(args) {
    const lines = [];
    lines.push(`*hoje — ${escapeMd(args.target)}*`);
    lines.push("");
    if (args.calDesc) {
        lines.push(escapeMd(args.calDesc));
        lines.push("");
    }
    if (args.tasks.length === 0) {
        lines.push(escapeMd("backlog limpo"));
        return lines.join("\n");
    }
    const shown = args.tasks.slice(0, 8);
    for (const t of shown) {
        lines.push(fmtTrafficTask(t));
    }
    if (args.tasks.length > 8) {
        lines.push(escapeMd(`... +${args.tasks.length - 8} outras`));
    }
    return lines.join("\n");
}
