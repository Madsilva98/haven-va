/**
 * Inline-button callback handler.
 *
 * Routes:
 *   priority:alta|media|baixa  → confirm a NEW_TASK with chosen priority
 *   priority:cancel            → drop a NEW_TASK proposal as false positive
 *   edit:apply                 → apply an EDIT_TASK to Notion
 *   edit:cancel                → drop an EDIT_TASK proposal as false positive
 *
 * Pending state is looked up by the bot's reply message id (the message
 * the button is attached to). If state is missing (bot restarted), we
 * tell the user the proposal expired and let them re-mention.
 */

import type { Context } from "grammy";

import { isFounder, getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { confirmationMessages } from "../messages/errors.js";
import * as notion from "../notion.js";
import { record } from "../feedback.js";
import { getPending, commitPending, cancelPending } from "../state/pending.js";
import type { Priority } from "../types.js";

const PRIORITY_MAP: Record<string, Priority> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export async function handleCallback(ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query) return;

  const data = query.data;
  const userId = query.from.id;
  const message = query.message;
  const botMessageId = message?.message_id;

  if (!data || botMessageId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (!isFounder(userId)) {
    await ctx.answerCallbackQuery({ text: "só founders podem confirmar" });
    return;
  }

  const senderName = getFounderName(userId);
  if (!senderName) {
    await ctx.answerCallbackQuery();
    return;
  }

  const proposal = await getPending(botMessageId);
  if (!proposal) {
    await ctx.answerCallbackQuery({ text: confirmationMessages.pendingExpired() });
    return;
  }

  const [scope, action] = data.split(":");

  try {
    if (scope === "priority" && proposal.type === "new_task") {
      if (action === "cancel") {
        await record(
          "false_positive",
          proposal.originalMsg,
          senderName,
          proposal.extraction,
          "❌ ignorar",
        );
        await cancelPending(botMessageId);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(confirmationMessages.newTaskIgnored(), {
          reply_parameters: { message_id: botMessageId },
        });
        await ctx.answerCallbackQuery();
        return;
      }

      const priority = action ? PRIORITY_MAP[action] : undefined;
      if (!priority) {
        await ctx.answerCallbackQuery();
        return;
      }

      const createdPageId = await notion.createTask(
        proposal.extraction,
        priority,
        proposal.originalMsg,
        proposal.originalSender,
      );
      notion.invalidateOpenTasksCache();
      await record(
        "confirmed",
        proposal.originalMsg,
        senderName,
        proposal.extraction,
        `priority:${priority}`,
      );
      await commitPending(botMessageId, createdPageId);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
      await ctx.reply(confirmationMessages.newTaskAdded(priority), {
        reply_parameters: { message_id: botMessageId },
      });
      await ctx.answerCallbackQuery();
      return;
    }

    if (scope === "edit" && proposal.type === "edit") {
      if (action === "cancel") {
        await record(
          "false_positive",
          proposal.originalMsg,
          senderName,
          proposal.extraction,
          "❌ deixa",
        );
        await cancelPending(botMessageId);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(confirmationMessages.editIgnored(), {
          reply_parameters: { message_id: botMessageId },
        });
        await ctx.answerCallbackQuery();
        return;
      }

      if (action === "apply") {
        await notion.updateTask(
          proposal.extraction.targetTaskId,
          proposal.extraction.field,
          proposal.extraction.newValue,
        );
        notion.invalidateOpenTasksCache();
        await record(
          "confirmed",
          proposal.originalMsg,
          senderName,
          proposal.extraction,
          "✅ atualiza",
        );
        await commitPending(botMessageId, proposal.extraction.targetTaskId);
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        await ctx.reply(confirmationMessages.editApplied(), {
          reply_parameters: { message_id: botMessageId },
        });
        await ctx.answerCallbackQuery();
        return;
      }
    }

    // Mismatched scope/proposal type — ignore quietly.
    await ctx.answerCallbackQuery();
  } catch (err) {
    log.error("callback.error", { err: String(err), data, botMessageId });
    await ctx.answerCallbackQuery({ text: "erro — tenta outra vez" });
  }
}
