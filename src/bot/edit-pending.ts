/**
 * EDIT_PENDING handler — applies a natural-language correction to a
 * recent bot action.
 *
 * v1 scope: only NEW_TASK and EDIT_TASK targets (the only types that
 * appear in the recent-actions buffer). REMINDER / LOG / DECISION /
 * LAUNCH_INTENT corrections are out of scope; if they arrive here we
 * log a warning and drop.
 */

import type { Context } from "grammy";

import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import type {
  ChatContext,
  EditPendingField,
  EditPendingIntent,
  RecentAction,
} from "../types.js";

export async function handleEditPending(
  tgCtx: Context,
  chatCtx: ChatContext,
  intent: EditPendingIntent,
): Promise<void> {
  const target = resolveTarget(intent, chatCtx.recentBotActions);
  if (!target) {
    log.warn("edit_pending.no_target", {
      ref: intent.ref,
      field: intent.field,
      bufferSize: chatCtx.recentBotActions.length,
    });
    return;
  }

  if (intent.field === "cancel") {
    await applyCancel(tgCtx, target);
    return;
  }

  if (target.type !== "NEW_TASK" && target.type !== "EDIT_TASK") {
    log.warn("edit_pending.unsupported_target_type", { type: target.type });
    return;
  }

  if (!target.notionPageId) {
    log.warn("edit_pending.no_notion_page", { id: target.id });
    await tgCtx.reply(
      "ainda não posso editar isso — confirma a proposta primeiro",
    );
    return;
  }

  await applyTaskEdit(tgCtx, target, intent.field, intent.value);
}

function resolveTarget(
  intent: EditPendingIntent,
  buffer: RecentAction[],
): RecentAction | null {
  const exact = buffer.find((a) => a.id === intent.ref);
  if (exact) return exact;
  // Fallback to most recent action overall.
  return buffer[0] ?? null;
}

async function applyCancel(
  tgCtx: Context,
  target: RecentAction,
): Promise<void> {
  if (target.notionPageId && target.status === "committed") {
    await notion.archivePage(target.notionPageId);
  }
  // For pending (not yet committed) actions, the user can also cancel
  // via the inline-keyboard button. We can't reach that button from
  // here, but we can mark it cancelled in the recent-actions buffer
  // so the next multi-intent call won't see it. The bot pending row
  // will get cleaned up when the user clicks the button (or stays as
  // a stale row, which is harmless).
  if (target.botMessageId !== null) {
    await notion
      .markCancelled(target.botMessageId)
      .catch((err) => log.warn("edit_pending.cancel_mark_failed", { err: String(err) }));
  }
  await tgCtx.reply("cancelado");
}

async function applyTaskEdit(
  tgCtx: Context,
  target: RecentAction,
  field: EditPendingField,
  value: string | null,
): Promise<void> {
  if (!target.notionPageId || value === null) return;

  switch (field) {
    case "owner":
      await notion.updateTask(target.notionPageId, "owner", value);
      await tgCtx.reply(`ok, mudei o owner para ${value} ✏️`);
      return;
    case "area":
      await notion.updateTask(target.notionPageId, "area", value);
      await tgCtx.reply(`ok, área agora é ${value} ✏️`);
      return;
    case "priority":
      await notion.updateTask(target.notionPageId, "prioridade", value);
      await tgCtx.reply(`ok, prioridade agora é ${value} ✏️`);
      return;
    case "title":
    case "when":
    case "tags":
      // Not supported in v1 for committed tasks — would need extra
      // notion helpers. Silently drop with a log.
      log.warn("edit_pending.field_not_supported", { field });
      return;
    case "cancel":
      // handled in applyCancel — defensive
      return;
  }
}
