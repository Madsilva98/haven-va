/**
 * Minimal Telegram Bot API client used by cron endpoints.
 *
 * Bot init in `src/bot/index.ts` is grammy-based and is mounted on the
 * webhook handler. Cron handlers don't want to spin up a full Bot
 * instance — so this file talks to the HTTP API directly.
 */

import { log } from "./log.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID;

type ParseMode = "MarkdownV2" | "HTML";

interface SendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
  error_code?: number;
}

async function sendMessage(
  chatId: number | string,
  text: string,
  parseMode?: ParseMode,
): Promise<number> {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("telegram: TELEGRAM_BOT_TOKEN is not set");
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as SendMessageResponse;
  if (!data.ok || !data.result) {
    log.error("telegram.send_failed", {
      chatId,
      status: res.status,
      description: data.description,
      errorCode: data.error_code,
    });
    throw new Error(
      `telegram.sendMessage failed: ${data.description ?? res.status}`,
    );
  }
  return data.result.message_id;
}

export async function sendGroupMessage(
  text: string,
  parseMode?: ParseMode,
): Promise<number> {
  if (!TELEGRAM_GROUP_ID) {
    throw new Error("telegram: TELEGRAM_GROUP_ID is not set");
  }
  return sendMessage(TELEGRAM_GROUP_ID, text, parseMode);
}

export async function sendDM(
  telegramUserId: number,
  text: string,
  parseMode?: ParseMode,
): Promise<number> {
  return sendMessage(telegramUserId, text, parseMode);
}
