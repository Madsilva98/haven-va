/**
 * Phase 5 — DECISION proposal & confirmation.
 *
 * Called from `src/bot/index.ts` whenever the Tier 1 classifier returns
 * "DECISION" and `extractDecision` produces a result. Posts a proposal
 * with `[✅ regista] [❌ não]` and writes to the Notion Decisões DB on
 * confirm.
 *
 * Pending state is module-scoped (Map keyed by Telegram bot message id).
 * Same TTL pattern as `todiscuss.ts`.
 *
 * Wiring: callback_data starting with "decision:" routes to
 * `handleDecisionCallback` in `src/bot/index.ts`.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

import { log } from "../lib/log.js";
import { formatDecisionProposal } from "../messages/decisions.js";
import * as notion from "../notion.js";
import type { Area, FounderName } from "../types.js";

export interface DecisionExtraction {
  decisao: string;
  area: Area;
  tomadaPor: FounderName[];
  notas: string;
}

interface PendingDecision {
  extraction: DecisionExtraction;
  originalMsg: string;
  originalSender: FounderName;
  createdAt: number;
}

const pending = new Map<number, PendingDecision>();
const PENDING_TTL_MS = 30 * 60 * 1000;

function gc(): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [k, v] of pending) {
    if (v.createdAt < cutoff) pending.delete(k);
  }
}

export function decisionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ regista", "decision:keep")
    .text("❌ não", "decision:cancel");
}

/**
 * Posts the decision proposal and stores pending state.
 * Caller passes the `Context` from the message that triggered the pipeline,
 * plus the `DecisionExtraction` produced by `extractDecision`.
 */
export async function proposeDecision(
  ctx: Context,
  extraction: DecisionExtraction,
  originalMsg: string,
  sender: FounderName,
): Promise<void> {
  const proposal = formatDecisionProposal(extraction);
  const sent = await ctx.reply(proposal.text, {
    parse_mode: proposal.parseMode,
    reply_markup: decisionKeyboard(),
    reply_parameters: ctx.message
      ? { message_id: ctx.message.message_id }
      : undefined,
  });

  gc();
  pending.set(sent.message_id, {
    extraction,
    originalMsg,
    originalSender: sender,
    createdAt: Date.now(),
  });
  log.debug("decision.proposal_sent", {
    botMessageId: sent.message_id,
    area: extraction.area,
  });
}

/**
 * Handles the [✅ regista] [❌ não] keyboard taps.
 * Callback data shape: "decision:<keep|cancel>".
 */
export async function handleDecisionCallback(ctx: Context): Promise<void> {
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
      await ctx.editMessageText("❌ não regista");
    } catch {
      // ignore
    }
    log.info("decision.cancelled", { botMessageId });
    return;
  }

  if (key !== "keep") {
    await ctx.answerCallbackQuery({ text: "opção inválida" });
    return;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    await notion.createDecision({
      decisao: entry.extraction.decisao,
      area: entry.extraction.area,
      tomadaPor: entry.extraction.tomadaPor,
      data: today,
      estado: "Pendente implementação",
      notas: entry.extraction.notas,
    });
    pending.delete(botMessageId);
    await ctx.answerCallbackQuery({ text: "✅ registada" });
    try {
      await ctx.editMessageText("✅ decisão registada");
    } catch {
      // ignore
    }
    log.info("decision.created", {
      botMessageId,
      area: entry.extraction.area,
    });
  } catch (err) {
    log.error("decision.create_failed", { err: String(err) });
    await ctx.answerCallbackQuery({ text: "erro a gravar — tenta outra vez" });
  }
}
