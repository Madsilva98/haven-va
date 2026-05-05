/**
 * Inline keyboard builders for proposal messages.
 * Keep callback_data ASCII-only to avoid Telegram size/encoding edge cases.
 */

import { InlineKeyboard } from "grammy";

export function taskUndoKeyboard(pageId: string): InlineKeyboard {
  return new InlineKeyboard().text("↩ Desfazer", `task:undo:${pageId}`);
}

export function editKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ atualiza", "edit:apply")
    .text("❌ deixa", "edit:cancel");
}
