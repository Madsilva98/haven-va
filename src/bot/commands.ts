/**
 * Slash commands: /help, /start, /task <descrição>, /status, /hoje, /dashboard.
 *
 * /task creates a task directly in Notion without going through the AI pipeline.
 */

import type { Context } from "grammy";

import * as calendar from "../lib/calendar.js";
import { getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { HELP_MESSAGE } from "../messages/help.js";
import { WELCOME_MESSAGE } from "../messages/welcome.js";
import { formatHoje, rankTasks } from "../messages/cycle.js";
import { formatDashboard } from "../messages/dashboard.js";
import * as notion from "../notion.js";
import { currentWeekLabel } from "../lib/week.js";
import type { FounderName } from "../types.js";
import { buildFreeTimeDesc } from "../crons/daily-madalena.js";
import { taskUndoKeyboard } from "./keyboards.js";

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(WELCOME_MESSAGE);
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(HELP_MESSAGE);
}

export async function handleTask(ctx: Context): Promise<void> {
  const fullText = ctx.message?.text ?? "";
  const description = fullText.replace(/^\/task(@\w+)?\s*/i, "").trim();

  if (!description) {
    await ctx.reply("usa `/task <descrição>` para forçar uma task", {
      parse_mode: "Markdown",
    });
    return;
  }

  const senderId = ctx.from?.id;
  if (!senderId) return;
  const senderName = getFounderName(senderId);
  if (!senderName) return;

  try {
    const pageId = await notion.createTask(
      {
        title: description.slice(0, 80),
        owner: "Unassigned",
        area: "Outro",
        why: "levantado via /task",
      },
      "Média",
      description,
      senderName,
    );
    await ctx.reply(`✅ task criada: "${description.slice(0, 80)}"`, {
      reply_markup: taskUndoKeyboard(pageId),
    });
  } catch (err) {
    log.error("commands.task.failed", { err: String(err) });
    await ctx.reply("erro a criar task — tenta outra vez");
  }
}

export async function handleHoje(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  const sender = fromId ? getFounderName(fromId) : null;
  if (!sender) return;

  const arg = (ctx.message?.text ?? "")
    .replace(/^\/hoje(@\w+)?\s*/i, "")
    .trim()
    .toLowerCase();
  const nameMap: Record<string, FounderName> = {
    madalena: "Madalena",
    mafalda: "Mafalda",
    beatriz: "Beatriz",
    bia: "Beatriz",
  };
  const target: FounderName = (arg ? nameMap[arg] : undefined) ?? sender;

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
  } catch (err) {
    log.error("commands.hoje.failed", { err: String(err) });
    await ctx.reply("erro a buscar tasks — tenta outra vez");
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const feedback = await notion.getRecentFeedback(100);
    let confirmed = 0;
    let falsePositive = 0;
    let corrections = 0;
    for (const entry of feedback) {
      if (entry.type === "confirmed") confirmed++;
      else if (entry.type === "false_positive") falsePositive++;
      else if (entry.type === "correction") corrections++;
    }
    const total = confirmed + falsePositive;
    const rate = total === 0 ? "—" : `${Math.round((confirmed / total) * 100)}%`;

    const lines = [
      "📊 últimas ~100 interacções:",
      `• confirmadas: ${confirmed}`,
      `• ignoradas: ${falsePositive}`,
      `• correcções: ${corrections}`,
      `• taxa de acerto: ${rate}`,
    ];
    await ctx.reply(lines.join("\n"));
  } catch (err) {
    log.error("status.failed", { err: String(err) });
    await ctx.reply("erro a buscar status");
  }
}

export async function handleDashboard(ctx: Context): Promise<void> {
  try {
    const [focus, toDiscuss] = await Promise.all([
      notion.getFounderFocusForWeek(currentWeekLabel()),
      notion.getToDiscussPending(),
    ]);
    const text = formatDashboard({ focus, toDiscuss });
    await ctx.reply(text, { parse_mode: "MarkdownV2" });
  } catch (err) {
    log.error("commands.dashboard.failed", { err: String(err) });
    await ctx.reply("erro a carregar dashboard — tenta outra vez");
  }
}
