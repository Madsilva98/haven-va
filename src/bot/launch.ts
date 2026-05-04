/**
 * Phase 5 — LAUNCH_INTENT proposal & task creation.
 *
 * When `extractLaunch` produces a result, the bot posts a proposal:
 *   "vais lançar 'X' a YYYY-MM-DD? proponho N tasks com base no template
 *    'programa-novo':
 *    - task 1
 *    - task 2
 *    - task 3
 *
 *    + (N-3) mais"
 *
 * On `[✅ cria todas]` we expand the template and write each task to the
 * Notion Master Backlog. On `[❌ deixa]` we drop the proposal.
 *
 * `notion.createTask` takes a `NewTaskExtraction` shape (title/owner/area/why)
 * plus a priority — it does not accept a deadline directly, so we follow up
 * with `notion.updateTask(pageId, "deadline", iso)` for each task.
 *
 * Wiring: callback_data starting with "launch:" routes to
 * `handleLaunchCallback` in `src/bot/index.ts`.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

import { log } from "../lib/log.js";
import { formatLaunchProposal } from "../messages/decisions.js";
import * as notion from "../notion.js";
import type { FounderName, NewTaskExtraction, OwnerValue } from "../types.js";
import type { LaunchTemplateId } from "../prompts/launch-templates.js";

export interface LaunchExtraction {
  /** What is being launched, e.g. "programa abdominal", "parceria com Decathlon". */
  name: string;
  templateId: LaunchTemplateId;
  /** ISO date `YYYY-MM-DD`. */
  launchDate: string;
  owner: OwnerValue;
}
import {
  generateTasksFromTemplate,
  type GeneratedLaunchTask,
} from "./templates.js";

interface PendingLaunch {
  extraction: LaunchExtraction;
  tasks: GeneratedLaunchTask[];
  originalMsg: string;
  originalSender: FounderName;
  createdAt: number;
}

const pending = new Map<number, PendingLaunch>();
const PENDING_TTL_MS = 30 * 60 * 1000;

function gc(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) {
    if (v.createdAt < cutoff) pending.delete(k);
  }
}

export function launchKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ cria todas", "launch:create")
    .text("❌ deixa", "launch:cancel");
}

/**
 * Posts the launch proposal and stores pending state.
 */
export async function proposeLaunch(
  ctx: Context,
  extraction: LaunchExtraction,
  originalMsg: string,
  sender: FounderName,
): Promise<void> {
  const tasks = generateTasksFromTemplate(extraction);
  const proposal = formatLaunchProposal(
    extraction,
    tasks.length,
    tasks.map((t) => t.title),
  );

  const sent = await ctx.reply(proposal.text, {
    parse_mode: proposal.parseMode,
    reply_markup: launchKeyboard(),
    reply_parameters: ctx.message
      ? { message_id: ctx.message.message_id }
      : undefined,
  });

  gc();
  pending.set(sent.message_id, {
    extraction,
    tasks,
    originalMsg,
    originalSender: sender,
    createdAt: Date.now(),
  });
  log.debug("launch.proposal_sent", {
    botMessageId: sent.message_id,
    template: extraction.templateId,
    taskCount: tasks.length,
  });
}

/**
 * Handles the [✅ cria todas] [❌ deixa] keyboard taps.
 * Callback data shape: "launch:<create|cancel>".
 */
export async function handleLaunchCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const botMessageId = ctx.callbackQuery?.message?.message_id;
  if (!botMessageId) return;
  const key = data.split(":")[1] ?? "";

  const entry = pending.get(botMessageId);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "expirou ou já foi resolvido" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // ignore
    }
    return;
  }

  if (key === "cancel") {
    pending.delete(botMessageId);
    await ctx.answerCallbackQuery({ text: "ok" });
    try {
      await ctx.editMessageText("❌ não criei nada");
    } catch {
      // ignore
    }
    log.info("launch.cancelled", { botMessageId });
    return;
  }

  if (key !== "create") {
    await ctx.answerCallbackQuery({ text: "opção inválida" });
    return;
  }

  try {
    let created = 0;
    for (const task of entry.tasks) {
      const newTask: NewTaskExtraction = {
        title: task.title,
        owner: task.owner,
        area: task.area,
        why: `auto-gerada do template '${entry.extraction.templateId}' para o lançamento de ${entry.extraction.name}`,
      };
      const pageId = await notion.createTask(
        newTask,
        task.priority,
        entry.originalMsg,
        entry.originalSender,
      );
      try {
        await notion.updateTask(pageId, "deadline", task.deadline);
      } catch (err) {
        // Deadline is best-effort — log and keep going so the user still
        // gets the rest of the task list.
        log.warn("launch.deadline_failed", {
          pageId,
          deadline: task.deadline,
          err: String(err),
        });
      }
      created += 1;
    }

    pending.delete(botMessageId);
    await ctx.answerCallbackQuery({ text: "✅ criadas" });
    try {
      await ctx.editMessageText(
        `✅ ${created} tasks criadas para o lançamento de ${entry.extraction.name}`,
      );
    } catch {
      // ignore
    }
    log.info("launch.tasks_created", {
      botMessageId,
      template: entry.extraction.templateId,
      created,
    });
  } catch (err) {
    log.error("launch.create_failed", { err: String(err) });
    await ctx.answerCallbackQuery({ text: "erro a gravar — tenta outra vez" });
  }
}
