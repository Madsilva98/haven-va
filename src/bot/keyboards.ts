/**
 * Inline keyboard builders for proposal messages.
 * Keep callback_data ASCII-only to avoid Telegram size/encoding edge cases.
 */

import { InlineKeyboard } from "grammy";

export function priorityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔴 alta", "priority:alta")
    .text("🟡 média", "priority:media")
    .text("🟢 baixa", "priority:baixa")
    .text("❌ ignorar", "priority:cancel");
}

export function editKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ atualiza", "edit:apply")
    .text("❌ deixa", "edit:cancel");
}
