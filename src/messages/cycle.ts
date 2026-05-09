/**
 * Telegram MarkdownV2 templates for the Phase 2 weekly cycle messages.
 *
 * All copy is pt-PT, "tu" register, lowercase preferred. No marketing
 * speak. Templates are pure functions of structured data so they can
 * be unit-tested without hitting Telegram or Notion.
 */

import type {
  FounderFocusEntry,
  FounderName,
  OpenTask,
} from "../types.js";

/**
 * Escape characters reserved by Telegram MarkdownV2.
 * Per the Bot API docs, these chars must be backslash-escaped in any
 * text placed inside a MarkdownV2 message:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMd(s: string): string {
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, (m) => `\\${m}`);
}

function indent(line: string): string {
  return `  ${line}`;
}

function fmtTask(t: OpenTask): string {
  const title = escapeMd(t.title);
  const owner = escapeMd(t.owner);
  const parts: string[] = [owner];
  if (t.priority) parts.push(escapeMd(t.priority.toLowerCase()));
  if (t.deadline) parts.push(escapeMd(t.deadline));
  return `• ${title} \\(${parts.join(", ")}\\)`;
}

function fmtTaskNoOwner(t: OpenTask): string {
  const title = escapeMd(t.title);
  const parts: string[] = [];
  if (t.priority) parts.push(escapeMd(t.priority.toLowerCase()));
  if (t.deadline) parts.push(escapeMd(t.deadline));
  const tail = parts.length ? ` \\(${parts.join(", ")}\\)` : "";
  return `• ${title}${tail}`;
}

function groupByOwner(tasks: OpenTask[]): Map<string, OpenTask[]> {
  const map = new Map<string, OpenTask[]>();
  for (const t of tasks) {
    const key = t.owner;
    const arr = map.get(key) ?? [];
    arr.push(t);
    map.set(key, arr);
  }
  return map;
}

// ----- Friday balance -----

export interface FridayBalanceArgs {
  weekLabel: string;
  priorities: OpenTask[];
  completed: OpenTask[];
  overdue: OpenTask[];
  focus: FounderFocusEntry[];
}

export function formatFridayBalance(args: FridayBalanceArgs): string {
  const lines: string[] = [];
  lines.push(`*balanço de sexta — ${escapeMd(args.weekLabel)}*`);
  lines.push("");

  // Foco operacional definido por cada uma
  if (args.focus.length > 0) {
    lines.push("*foco da semana*");
    for (const f of args.focus) {
      lines.push(
        `• ${escapeMd(f.founder)}: ${escapeMd(f.focoOperacional)}`,
      );
    }
    lines.push("");
  }

  lines.push("*prioridades semanais*");
  if (args.priorities.length === 0) {
    lines.push(escapeMd("(ninguém marcou prioridades esta semana)"));
  } else {
    for (const t of args.priorities) lines.push(fmtTask(t));
  }
  lines.push("");

  lines.push(`*feito esta semana \\(${args.completed.length}\\)*`);
  if (args.completed.length === 0) {
    lines.push(escapeMd("nada fechado ainda"));
  } else {
    for (const t of args.completed.slice(0, 15)) lines.push(fmtTask(t));
    if (args.completed.length > 15) {
      lines.push(escapeMd(`... +${args.completed.length - 15} outras`));
    }
  }
  lines.push("");

  lines.push(`*atrasadas \\(${args.overdue.length}\\)*`);
  if (args.overdue.length === 0) {
    lines.push(escapeMd("nenhuma — boa"));
  } else {
    for (const t of args.overdue.slice(0, 10)) lines.push(fmtTask(t));
    if (args.overdue.length > 10) {
      lines.push(escapeMd(`... +${args.overdue.length - 10} outras`));
    }
  }

  return lines.join("\n");
}

// ----- Weekend brief -----

export interface WeekendBriefArgs {
  weekLabel: string;
  openTasks: OpenTask[];
  focusByFounder: FounderFocusEntry[];
  toDiscuss?: { tema: string; adicionadoPor: FounderName }[];
}

export function formatWeekendBrief(args: WeekendBriefArgs): string {
  const lines: string[] = [];
  lines.push(
    `*preparação para a reunião — ${escapeMd(args.weekLabel)}*`,
  );
  lines.push("");

  lines.push("*foco operacional desta semana*");
  if (args.focusByFounder.length === 0) {
    lines.push(escapeMd("(ninguém escreveu foco)"));
  } else {
    for (const f of args.focusByFounder) {
      lines.push(
        `• ${escapeMd(f.founder)}: ${escapeMd(f.focoOperacional)}`,
      );
    }
  }
  lines.push("");

  lines.push(`*por fechar \\(${args.openTasks.length}\\)*`);
  if (args.openTasks.length === 0) {
    lines.push(escapeMd("nada — backlog limpo"));
  } else {
    const grouped = groupByOwner(args.openTasks);
    for (const [owner, tasks] of grouped) {
      lines.push(`_${escapeMd(owner)}_`);
      for (const t of tasks.slice(0, 8)) lines.push(indent(fmtTaskNoOwner(t)));
      if (tasks.length > 8) {
        lines.push(indent(escapeMd(`... +${tasks.length - 8} outras`)));
      }
    }
  }

  if (args.toDiscuss && args.toDiscuss.length > 0) {
    lines.push("");
    lines.push("*para discutir*");
    for (const td of args.toDiscuss) {
      lines.push(
        `• ${escapeMd(td.tema)} — ${escapeMd(td.adicionadoPor)}`,
      );
    }
  }

  return lines.join("\n");
}

// ----- Monday priorities -----

export interface MondayPrioritiesArgs {
  weekLabel: string;
  prioritiesByFounder: Record<FounderName, OpenTask[]>;
  focus: FounderFocusEntry[];
}

export function formatMondayPriorities(args: MondayPrioritiesArgs): string {
  const lines: string[] = [];
  lines.push(`*segunda — ${escapeMd(args.weekLabel)}*`);
  lines.push("");
  lines.push(escapeMd("aqui vai o plano da semana:"));
  lines.push("");

  const founders: FounderName[] = ["Madalena", "Mafalda", "Beatriz"];
  const focusMap = new Map<FounderName, string>();
  for (const f of args.focus) focusMap.set(f.founder, f.focoOperacional);

  for (const founder of founders) {
    const tasks = args.prioritiesByFounder[founder] ?? [];
    const focus = focusMap.get(founder);
    if (tasks.length === 0 && !focus) continue;

    lines.push(`*${escapeMd(founder)}*`);
    if (focus) {
      lines.push(`_foco_: ${escapeMd(focus)}`);
    }
    if (tasks.length === 0) {
      lines.push(escapeMd("(sem prioridades marcadas — usa /week)"));
    } else {
      for (const t of tasks) lines.push(fmtTaskNoOwner(t));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ----- Daily Madalena placeholder (used by monday cron) -----

export interface DailyMadalenaArgs {
  tasks: OpenTask[];
}

export function formatDailyMadalenaPlaceholder(
  args: DailyMadalenaArgs,
): string {
  const lines: string[] = [];
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

const PRIORITY_RANK: Record<string, number> = { "Alta": 0, "Média": 1, "Baixa": 2 };

export function rankTasks(tasks: OpenTask[]): OpenTask[] {
  return [...tasks].sort((a, b) => {
    const pa = a.priority ? (PRIORITY_RANK[a.priority] ?? 3) : 3;
    const pb = b.priority ? (PRIORITY_RANK[b.priority] ?? 3) : 3;
    if (pa !== pb) return pa - pb;
    const da = a.deadline ?? "9999-12-31";
    const db = b.deadline ?? "9999-12-31";
    return da < db ? -1 : da > db ? 1 : 0;
  });
}

export type TrafficLight = "red" | "yellow" | "green";

export function trafficLight(task: OpenTask): TrafficLight {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });
  if (task.priority === "Alta" || task.deadline === today) return "red";
  if (task.deadline) {
    const daysUntil = Math.ceil(
      (new Date(task.deadline).getTime() - new Date(today).getTime()) /
        (1000 * 60 * 60 * 24),
    );
    if (daysUntil < 0) return "red";
    if (task.priority === "Média" || daysUntil <= 3) return "yellow";
  } else if (task.priority === "Média") {
    return "yellow";
  }
  return "green";
}

const LIGHT_EMOJI: Record<TrafficLight, string> = {
  red: "🔴",
  yellow: "🟡",
  green: "🟢",
};

function fmtTrafficTask(t: OpenTask): string {
  const light = LIGHT_EMOJI[trafficLight(t)];
  const title = escapeMd(t.title);
  const parts: string[] = [];
  if (t.priority) parts.push(escapeMd(t.priority.toLowerCase()));
  if (t.deadline) parts.push(escapeMd(t.deadline));
  const tail = parts.length ? ` \\(${parts.join(", ")}\\)` : "";
  return `${light} ${title}${tail}`;
}

// ----- Daily DM (calendar-aware, Phase 4) -----

export interface DailyDMArgs {
  founder: FounderName;
  tasks: OpenTask[];
  calDesc: string; // "" when not Madalena or calendar not configured
}

export function formatDailyDM(args: DailyDMArgs): string {
  const lines: string[] = [];

  if (args.calDesc) {
    lines.push(`Bom dia\\! ${escapeMd(args.calDesc)}\\.`);
    lines.push("");
  } else {
    lines.push(`Bom dia, ${escapeMd(args.founder)}\\!`);
    lines.push("");
  }

  if (args.tasks.length === 0) {
    lines.push(escapeMd("nada no backlog — descansa um bocado"));
    return lines.join("\n");
  }

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Lisbon" });
  const deadlineToday = args.tasks.filter((t) => t.deadline === today);
  const remaining = args.tasks.filter((t) => t.deadline !== today);

  if (deadlineToday.length > 0) {
    lines.push("‼️ *deadline hoje*");
    for (const t of deadlineToday) {
      lines.push(`• ${escapeMd(t.title)}`);
    }
    lines.push("");
  }

  const reds = remaining.filter((t) => trafficLight(t) === "red");
  const yellows = remaining.filter((t) => trafficLight(t) === "yellow");
  const greens = remaining.filter((t) => trafficLight(t) === "green");

  const shown = [...reds, ...yellows, ...greens].slice(0, 5);
  for (const t of shown) {
    if (trafficLight(t) === "green") {
      lines.push(`🟢 ${escapeMd("Se sobrar tempo:")} ${escapeMd(t.title)}`);
    } else {
      lines.push(fmtTrafficTask(t));
    }
  }

  return lines.join("\n");
}

// ----- /hoje command -----

export interface HojeArgs {
  target: FounderName;
  tasks: OpenTask[];
  calDesc: string;
}

export function formatHoje(args: HojeArgs): string {
  const lines: string[] = [];
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
