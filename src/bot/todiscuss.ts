/**
 * Phase 5 — `/todiscuss` command.
 *
 * Flow:
 *   1. User types `/todiscuss <texto>` in any chat the bot is in.
 *   2. Bot replies with a proposal + inline keyboard for urgency:
 *      [🟢 pode esperar] [🟡 decisão rápida] [🔴 urgente] [❌ cancelar]
 *   3. On urgency tap → `notion.createToDiscuss(...)`, reply with a confirm.
 *   4. On cancel → bot replies "cancelado".
 *
 * Pending state is module-scoped (Map keyed by Telegram bot message id).
 * The bot is deployed on Railway as a long-running process per the stack
 * recommendation, so in-memory state survives across user taps.
 *
 * Wiring: the caller in `src/bot/index.ts` registers
 *   bot.command("todiscuss", handleToDiscussCommand)
 *   // and routes callback_data starting with "todiscuss:" to handleToDiscussCallback
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

import { getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { formatToDiscussProposal } from "../messages/decisions.js";
import * as notion from "../notion.js";
import type { Area, FounderName, ToDiscussUrgency } from "../types.js";

interface PendingToDiscuss {
  tema: string;
  adicionadoPor: FounderName;
  createdAt: number;
}

const pending = new Map<number, PendingToDiscuss>();
const PENDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

function gc(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) {
    if (v.createdAt < cutoff) pending.delete(k);
  }
}

export function todiscussKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🟢 pode esperar", "todiscuss:wait")
    .text("🟡 decisão rápida", "todiscuss:fast")
    .row()
    .text("🔴 urgente", "todiscuss:urgent")
    .text("❌ cancelar", "todiscuss:cancel");
}

const URGENCY_BY_KEY: Record<string, ToDiscussUrgency> = {
  wait: "Pode esperar",
  fast: "Precisa de decisão rápida",
  urgent: "Urgente",
};

/**
 * Handle `/todiscuss <texto>` — proposes urgency selection.
 */
export async function handleToDiscussCommand(ctx: Context): Promise<void> {
  const fromId = ctx.from?.id;
  if (!fromId) return;
  const sender = getFounderName(fromId);
  if (!sender) return;

  // grammy puts the args after the command in `ctx.match` for command handlers.
  const raw =
    typeof ctx.match === "string"
      ? ctx.match
      : ctx.message?.text?.replace(/^\/todiscuss(@\S+)?\s*/i, "") ?? "";
  const tema = raw.trim();
  if (!tema) {
    await ctx.reply("usa: /todiscuss <texto>");
    return;
  }

  // Default urgency in the proposal preview is "Pode esperar"; the buttons
  // let the user pick the real one before we write to Notion.
  const proposal = formatToDiscussProposal(tema, "Pode esperar");

  const sent = await ctx.reply(proposal.text, {
    parse_mode: proposal.parseMode,
    reply_markup: todiscussKeyboard(),
    reply_parameters: ctx.message
      ? { message_id: ctx.message.message_id }
      : undefined,
  });

  gc();
  pending.set(sent.message_id, {
    tema,
    adicionadoPor: sender,
    createdAt: Date.now(),
  });
  log.debug("todiscuss.proposal_sent", {
    botMessageId: sent.message_id,
    sender,
  });
}

/**
 * Handle the inline-button reply on a /todiscuss proposal.
 * Callback data shape: "todiscuss:<wait|fast|urgent|cancel>".
 */
export async function handleToDiscussCallback(ctx: Context): Promise<void> {
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
      // ignore — message may already be edited
    }
    return;
  }

  if (key === "cancel") {
    pending.delete(botMessageId);
    await ctx.answerCallbackQuery({ text: "cancelado" });
    try {
      await ctx.editMessageText("❌ cancelado");
    } catch {
      // ignore
    }
    log.info("todiscuss.cancelled", { botMessageId });
    return;
  }

  const urgencia = URGENCY_BY_KEY[key];
  if (!urgencia) {
    await ctx.answerCallbackQuery({ text: "opção inválida" });
    return;
  }

  try {
    // Area defaults to "Outro"; future versions can ask the LLM.
    const area: Area = "Outro";
    await notion.createToDiscuss({
      tema: entry.tema,
      adicionadoPor: entry.adicionadoPor,
      urgencia,
      area,
      resolucao: "",
    });
    pending.delete(botMessageId);
    await ctx.answerCallbackQuery({ text: "✅ adicionado" });
    try {
      await ctx.editMessageText(
        `✅ adicionado ao To Discuss (${urgencia.toLowerCase()})`,
      );
    } catch {
      // ignore
    }
    log.info("todiscuss.created", { botMessageId, urgencia });
  } catch (err) {
    log.error("todiscuss.create_failed", { err: String(err) });
    await ctx.answerCallbackQuery({ text: "erro a gravar — tenta outra vez" });
  }
}
