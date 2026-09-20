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
  Status,
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

function fmtTaskNoOwner(t: OpenTask): string {
  const title = escapeMd(t.title);
  const parts: string[] = [];
  if (t.priority) parts.push(escapeMd(t.priority.toLowerCase()));
  if (t.deadline) parts.push(escapeMd(t.deadline));
  const tail = parts.length ? ` \\(${parts.join(", ")}\\)` : "";
  return `• ${title}${tail}`;
}

// 🟢 Feito, 🟡 Em curso, 🔴 To do (as asked) — ⚪ covers Cancelado, which
// wasn't part of the spec and doesn't read as "still outstanding".
function statusEmoji(status: Status): string {
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

// A ⏰ suffix keeps the "this is overdue" signal alive now that atrasadas
// no longer gets its own section — otherwise a red (To do, overdue) task
// would be visually identical to a red (To do, not due yet) one.
function fmtTaskColored(t: OpenTask, overdue: boolean): string {
  const title = escapeMd(t.title);
  const tail = t.deadline ? ` \\(${escapeMd(t.deadline)}\\)` : "";
  const overdueTag = overdue ? " ⏰" : "";
  return `${statusEmoji(t.status)} ${title}${tail}${overdueTag}`;
}

// ----- Friday balance -----

export interface FridayBalanceArgs {
  weekLabel: string;
  prioritiesByFounder: Record<FounderName, OpenTask[]>;
  completed: OpenTask[];
  overdue: OpenTask[];
  focus: FounderFocusEntry[];
}

// No separate "feito"/"atrasadas" sections (dropped 2026-09-20, founder's
// call) — completed and overdue tasks are folded into each founder's own
// block instead, deduped against her weekly priorities by task id. Tasks
// with no owner (Unassigned) have no founder block to land in and are
// dropped from this view.
export function formatFridayBalance(args: FridayBalanceArgs): string {
  const lines: string[] = [];
  lines.push(`*balanço de sexta — ${escapeMd(args.weekLabel)}*`);
  lines.push("");

  const founders: FounderName[] = ["Madalena", "Mafalda", "Beatriz"];
  const focusMap = new Map<FounderName, string>();
  for (const f of args.focus) focusMap.set(f.founder, f.focoOperacional);
  const overdueIds = new Set(args.overdue.map((t) => t.id));

  for (const founder of founders) {
    const byId = new Map<string, OpenTask>();
    for (const t of args.prioritiesByFounder[founder] ?? []) byId.set(t.id, t);
    for (const t of args.completed) if (t.owner === founder) byId.set(t.id, t);
    for (const t of args.overdue) if (t.owner === founder) byId.set(t.id, t);
    const tasks = [...byId.values()];

    const focus = focusMap.get(founder);
    if (tasks.length === 0 && !focus) continue;

    lines.push(`*${escapeMd(founder)}*`);
    if (focus) {
      lines.push(`_foco_: ${escapeMd(focus)}`);
    }
    if (tasks.length === 0) {
      lines.push(escapeMd("(sem tasks esta semana)"));
    } else {
      for (const t of tasks) lines.push(fmtTaskColored(t, overdueIds.has(t.id)));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
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

// ----- /week (read-only list of tasks marked "Prioridade semanal") -----

export interface WeeklyPrioritiesArgs {
  founder: FounderName;
  tasks: OpenTask[];
}

export function formatWeeklyPriorities(args: WeeklyPrioritiesArgs): string {
  const lines: string[] = [];
  lines.push(`*prioridades semanais — ${escapeMd(args.founder)}*`);
  lines.push("");
  if (args.tasks.length === 0) {
    lines.push(
      escapeMd(
        'nenhuma task marcada como prioridade semanal. usa o botão "📌 Prioridade semanal" ao criar uma task com /task.',
      ),
    );
    return lines.join("\n");
  }
  for (const t of args.tasks) {
    lines.push(`${fmtTaskNoOwner(t)} — _${escapeMd(t.status)}_`);
  }
  return lines.join("\n");
}

