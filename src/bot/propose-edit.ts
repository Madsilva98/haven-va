/**
 * EDIT_TASK intent handler — calls the existing editor.ts to resolve
 * the target task + field, posts a confirmation card with edit buttons,
 * and stores the pending row.
 *
 * The multi-intent extractor only flags EDIT_TASK as a label; the
 * editor.ts re-runs to do the semantic match against open tasks.
 */

import type { Context } from "grammy";

import { formatEditProposal } from "../messages/proposal.js";
import { addPending } from "../state/pending.js";
import type { ChatContext } from "../types.js";

import { extractEdit } from "./editor.js";
import { editKeyboard } from "./keyboards.js";

export async function proposeEditFromContext(
  tgCtx: Context,
  chatCtx: ChatContext,
): Promise<void> {
  const chatId = tgCtx.chat?.id;
  const replyToMessageId = tgCtx.message?.message_id;
  if (chatId === undefined) return;

  const extraction = await extractEdit(chatCtx);
  if (!extraction) return;

  const proposal = formatEditProposal(extraction);
  const sent = await tgCtx.reply(proposal.text, {
    parse_mode: proposal.parseMode,
    reply_markup: editKeyboard(),
    ...(replyToMessageId !== undefined
      ? { reply_parameters: { message_id: replyToMessageId } }
      : {}),
  });

  await addPending(
    {
      type: "edit",
      botMessageId: sent.message_id,
      extraction,
      originalMsg: chatCtx.text,
      originalSender: chatCtx.sender,
      createdAt: Date.now(),
    },
    chatId,
  );
}
