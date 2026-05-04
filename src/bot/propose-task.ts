/**
 * NEW_TASK intent handler — posts a proposal card with priority
 * buttons and stores the pending row.
 */

import type { Context } from "grammy";

import { getTelegramId } from "../lib/founders.js";
import { formatNewTaskProposal } from "../messages/proposal.js";
import { addPending } from "../state/pending.js";
import type { ChatContext, NewTaskIntent } from "../types.js";

import { priorityKeyboard } from "./keyboards.js";

export async function proposeNewTask(
  tgCtx: Context,
  chatCtx: ChatContext,
  intent: NewTaskIntent,
): Promise<void> {
  const chatId = tgCtx.chat?.id;
  const replyToMessageId = tgCtx.message?.message_id;
  if (chatId === undefined) return;

  const ownerName = intent.owner === "Unassigned" ? null : intent.owner;
  const ownerId = ownerName ? getTelegramId(ownerName) : null;

  const extraction = {
    title: intent.title,
    owner: intent.owner,
    area: intent.area,
    why: intent.why,
  };

  const proposal = formatNewTaskProposal(extraction, ownerId);
  const sent = await tgCtx.reply(proposal.text, {
    parse_mode: proposal.parseMode,
    reply_markup: priorityKeyboard(),
    ...(replyToMessageId !== undefined
      ? { reply_parameters: { message_id: replyToMessageId } }
      : {}),
  });

  await addPending(
    {
      type: "new_task",
      botMessageId: sent.message_id,
      extraction,
      originalMsg: chatCtx.text,
      originalSender: chatCtx.sender,
      createdAt: Date.now(),
    },
    chatId,
  );
}
