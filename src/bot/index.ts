/**
 * Bot setup and message router.
 *
 * Handles:
 *   - group messages → conversational assistant (handleAssistant)
 *   - private messages → DM router (handleDM)
 *   - slash commands: /help /start /task /hoje /status /dashboard
 *     /week /focus /remind /todiscuss
 *   - inline button callbacks: namespaced by data prefix
 */

import { Bot, type Context } from "grammy";

import * as calendar from "../lib/calendar.js";
import { getFounderName, isFounder } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { ErrorRateLimit, ERROR_MESSAGE } from "../messages/errors.js";
import { WELCOME_MESSAGE } from "../messages/welcome.js";
import * as notion from "../notion.js";
import type { FounderName } from "../types.js";

import { handleCallback as handlePhase1Callback } from "./callbacks.js";
import {
  handleDashboard,
  handleHelp,
  handleHoje,
  handleLista,
  handleStart,
  handleTask,
  handleProjects,
  handlePartners,
  handleEvents,
  handleInfluencers,
  handleCalendar,
  handleContent,
} from "./commands.js";
import { handleAssistant } from "./assistant.js";
import { handleDM } from "./dm.js";
import { pushRecent, getPriors, lastBotRepliesByChat } from "./history.js";
import {
  handleWeek,
  handleWeekCallback,
  handleWeekTextStep,
  isAwaitingFocusFor,
} from "./week.js";
import { handleFocus } from "./focus.js";
import { handleRemind } from "./remind.js";
import {
  handleToDiscussCommand,
  handleToDiscussCallback,
} from "./todiscuss.js";

const errorLimit = new ErrorRateLimit();

interface PendingFile {
  fileId: string;
  fileName: string;
  mimeType: string;
  expiresAt: number;
}
const pendingFileByUser = new Map<number, PendingFile>();
const PENDING_FILE_TTL_MS = 5 * 60 * 1000;

function parseCaptionForFileTarget(text: string): {
  db: string;
  pageName: string;
  section?: string;
} | null {
  const dbPatterns: Array<[RegExp, string]> = [
    [/\bprojeto\s+(.+?)(?:\s*[,\n]|\s+(?:na\s+)?sec[çc]|$)/i, "projects"],
    [/\bparceiro\s+(.+?)(?:\s*[,\n]|\s+(?:na\s+)?sec[çc]|$)/i, "partners"],
    [/\bevento\s+(.+?)(?:\s*[,\n]|\s+(?:na\s+)?sec[çc]|$)/i, "events"],
    [/\binfluencer\s+(.+?)(?:\s*[,\n]|\s+(?:na\s+)?sec[çc]|$)/i, "influencers"],
  ];
  let db: string | null = null;
  let pageName: string | null = null;
  for (const [re, dbName] of dbPatterns) {
    const m = text.match(re);
    if (m?.[1]) {
      db = dbName;
      pageName = m[1].trim().replace(/[,\s]+$/, "");
      break;
    }
  }
  if (!db || !pageName) return null;
  const secMatch = text.match(/sec[çc][aã]o\s+(.+?)(?:\s*[,\n]|$)/i);
  return { db, pageName, section: secMatch?.[1]?.trim() };
}

let botInstance: Bot | null = null;
let awaitingAuthCodeFrom: number | null = null;
let botInfoUserId: number | null = null;
const dedupedUpdates = new Set<number>();
const DEDUPE_MAX = 200;


function dedupe(updateId: number): boolean {
  if (dedupedUpdates.has(updateId)) return true;
  dedupedUpdates.add(updateId);
  if (dedupedUpdates.size > DEDUPE_MAX) {
    const first = dedupedUpdates.values().next().value;
    if (first !== undefined) dedupedUpdates.delete(first);
  }
  return false;
}

async function callbackRouter(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery();
    return;
  }
  const [scope] = data.split(":");
  try {
    if (scope === "priority" || scope === "edit" || scope === "task") {
      await handlePhase1Callback(ctx);
      return;
    }
    if (scope === "week") {
      const fromId = ctx.from?.id;
      const founder = fromId ? getFounderName(fromId) : null;
      if (!founder) {
        await ctx.answerCallbackQuery();
        return;
      }
      await handleWeekCallback(ctx, founder);
      return;
    }
    if (scope === "todiscuss") {
      await handleToDiscussCallback(ctx);
      return;
    }
    log.warn("callback.unknown_scope", { scope, data });
    await ctx.answerCallbackQuery();
  } catch (err) {
    log.error("callback.dispatch_failed", { err: String(err), data });
    try {
      await ctx.answerCallbackQuery({ text: "erro — tenta outra vez" });
    } catch {
      // already answered
    }
  }
}

export function buildBot(): Bot {
  if (botInstance) return botInstance;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const bot = new Bot(token);

  bot.api
    .getMe()
    .then((me) => {
      botInfoUserId = me.id;
      log.info("bot.identified", { username: me.username, id: me.id });
    })
    .catch((err) => log.error("bot.getMe_failed", { err: String(err) }));

  // Welcome on group join — only in the configured Haven group.
  bot.on("my_chat_member", async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status !== "member" && status !== "administrator") return;
    const groupId = Number(process.env.TELEGRAM_GROUP_ID);
    if (groupId && ctx.chat?.id !== groupId) return;
    try {
      await ctx.reply(WELCOME_MESSAGE);
    } catch (err) {
      log.warn("welcome.send_failed", { err: String(err) });
    }
  });

  // Register slash commands for Telegram dropdown.
  bot.api.setMyCommands([
    { command: "task",        description: "Criar task manualmente" },
    { command: "hoje",        description: "Ver as minhas tasks de hoje" },
    { command: "dashboard",   description: "Dashboard semanal" },
    { command: "projects",    description: "Ver os meus projetos em aberto" },
    { command: "partners",    description: "Ver os meus parceiros" },
    { command: "events",      description: "Ver os meus eventos" },
    { command: "influencers", description: "Ver os meus influencers" },
    { command: "calendar",    description: "Calendário — hoje e próximos 2 dias" },
    { command: "content",     description: "Content Calendar — próximos 3 dias" },
    { command: "todiscuss",   description: "Adicionar à lista de discussão" },
    { command: "remind",      description: "Criar lembrete" },
    { command: "week",        description: "Definir foco semanal" },
    { command: "lista",       description: "Ver uma lista (/lista compras)" },
    { command: "help",        description: "Ajuda" },
  ]).catch((err) => log.warn("bot.set_commands_failed", { err: String(err) }));

  // Slash commands (work in both group and DM).
  bot.command("start", handleStart);
  bot.command("help", handleHelp);
  bot.command("task", handleTask);
  bot.command("week", async (ctx) => {
    const fromId = ctx.from?.id;
    const founder = fromId ? getFounderName(fromId) : null;
    if (!founder) return;
    await handleWeek(ctx, founder);
  });
  bot.command("focus", async (ctx) => {
    const fromId = ctx.from?.id;
    const founder = fromId ? getFounderName(fromId) : null;
    if (!founder) return;
    await handleFocus(ctx, founder, ctx.message?.text ?? "");
  });
  bot.command("remind", handleRemind);
  bot.command("todiscuss", handleToDiscussCommand);
  bot.command("hoje", handleHoje);
  bot.command("dashboard", handleDashboard);
  bot.command("lista", handleLista);
  bot.command("projects", handleProjects);
  bot.command("partners", handlePartners);
  bot.command("events", handleEvents);
  bot.command("influencers", handleInfluencers);
  bot.command("calendar", handleCalendar);
  bot.command("content", handleContent);

  // Google Calendar auth — Madalena's private DM only.
  bot.command("auth", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (getFounderName(ctx.from?.id ?? 0) !== "Madalena") return;
    awaitingAuthCodeFrom = ctx.from!.id;
    await ctx.reply(
      "Abre o link, autoriza, copia o valor de code= da barra de endereço e cola aqui:",
    );
    await ctx.reply(calendar.getAuthUrl());
  });

  bot.command("cals", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (getFounderName(ctx.from?.id ?? 0) !== "Madalena") return;
    if (!calendar.isAuthenticated()) {
      await ctx.reply("faz /auth primeiro");
      return;
    }
    try {
      const cals = await calendar.listAllCalendars();
      if (cals.length === 0) {
        await ctx.reply("nenhum calendário encontrado");
        return;
      }
      const lines = cals.map((c) => `• ${c.summary}\n  ID: \`${c.id}\``).join("\n\n");
      await ctx.reply(
        `Calendários disponíveis:\n\n${lines}\n\nCopia os IDs que queres usar para GOOGLE_CALENDAR_IDS no .env`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      log.error("cals.failed", { err: String(err) });
      await ctx.reply("erro a listar calendários");
    }
  });

  // Inline button callbacks.
  bot.on("callback_query:data", callbackRouter);

  // File upload handler (documents + photos).
  async function handleFileUpload(
    ctx: Context,
    fromId: number,
    senderName: FounderName,
    fileId: string,
    fileName: string,
    mimeType: string,
    caption: string | undefined,
  ): Promise<void> {
    const target = caption ? parseCaptionForFileTarget(caption) : null;
    if (!target) {
      pendingFileByUser.set(fromId, {
        fileId,
        fileName,
        mimeType,
        expiresAt: Date.now() + PENDING_FILE_TTL_MS,
      });
      await ctx.reply(
        `📎 *${fileName}* — onde guardo?\nResponde com: \`projeto X\` ou \`parceiro Y, secção Contratos\``,
        { parse_mode: "Markdown" },
      );
      return;
    }
    await uploadFileToNotion(ctx, senderName, { fileId, fileName, mimeType }, target);
  }

  async function uploadFileToNotion(
    ctx: Context,
    senderName: FounderName,
    file: { fileId: string; fileName: string; mimeType: string },
    target: { db: string; pageName: string; section?: string },
  ): Promise<void> {
    const page = await notion.findPageInDb(target.db, target.pageName);
    if (!page) {
      await ctx.reply(`não encontrei "${target.pageName}" em ${target.db}`);
      return;
    }
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const fileInfo = await ctx.api.getFile(file.fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await notion.uploadAndAttachFile(page.id, file.fileName, file.mimeType, buffer, target.section);
    const where = target.section ? `, secção "${target.section}"` : "";
    await ctx.reply(`📎 "${file.fileName}" guardado em "${page.title}"${where}`);
  }

  bot.on("message:document", async (ctx) => {
    const fromId = ctx.from?.id;
    if (!fromId || !isFounder(fromId)) return;
    const senderName = getFounderName(fromId);
    if (!senderName) return;
    const doc = ctx.message.document;
    const fileName = doc.file_name ?? `file_${Date.now()}`;
    const mimeType = doc.mime_type ?? "application/octet-stream";
    try {
      await handleFileUpload(ctx, fromId, senderName, doc.file_id, fileName, mimeType, ctx.message.caption);
    } catch (err) {
      log.error("file_upload.failed", { err: String(err) });
      await ctx.reply("erro a guardar o ficheiro — tenta outra vez");
    }
  });

  bot.on("message:photo", async (ctx) => {
    const fromId = ctx.from?.id;
    if (!fromId || !isFounder(fromId)) return;
    const senderName = getFounderName(fromId);
    if (!senderName) return;
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    if (!photo) return;
    const fileName = `foto_${Date.now()}.jpg`;
    try {
      await handleFileUpload(ctx, fromId, senderName, photo.file_id, fileName, "image/jpeg", ctx.message.caption);
    } catch (err) {
      log.error("photo_upload.failed", { err: String(err) });
      await ctx.reply("erro a guardar a foto — tenta outra vez");
    }
  });

  // Text message router.
  bot.on("message:text", async (ctx) => {
    if (dedupe(ctx.update.update_id)) return;

    const fromId = ctx.from?.id;
    if (!fromId || !isFounder(fromId)) return;
    const senderName = getFounderName(fromId);
    if (!senderName) return;

    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;

    // 0) Pending file: user is responding with a target for a previously sent file.
    const pending = pendingFileByUser.get(fromId);
    if (pending && Date.now() < pending.expiresAt) {
      const target = parseCaptionForFileTarget(text);
      if (target) {
        pendingFileByUser.delete(fromId);
        try {
          await uploadFileToNotion(ctx, senderName, pending, target);
        } catch (err) {
          log.error("pending_file_upload.failed", { err: String(err) });
          await ctx.reply("erro a guardar o ficheiro — tenta outra vez");
        }
        return;
      }
    }

    // 1) DM-only: if mid-/week flow, route there first.
    if (chatType === "private" && isAwaitingFocusFor(fromId)) {
      try {
        await handleWeekTextStep(ctx, senderName, text);
      } catch (err) {
        log.error("week.text_step_failed", { err: String(err) });
      }
      return;
    }

    // 2) DM router.
    if (chatType === "private") {
      // Google Calendar auth code intercept.
      if (awaitingAuthCodeFrom === fromId && text.startsWith("4/")) {
        try {
          await calendar.exchangeCodeForToken(text.trim());
          awaitingAuthCodeFrom = null;
          await ctx.reply(
            "✅ Google Calendar autenticado! Usa /cals para ver os teus calendários.",
          );
        } catch (err) {
          log.warn("auth.exchange_failed", { err: String(err) });
          await ctx.reply("Código inválido. Tenta /auth de novo.");
        }
        return;
      }

      try {
        const handled = await handleDM(ctx);
        if (handled) return;
      } catch (err) {
        log.error("dm.unhandled", { err: String(err) });
        return;
      }
    }

    // 3) Group pipeline.
    const repliedTo = ctx.message.reply_to_message;
    const isReplyToBot =
      botInfoUserId !== null && repliedTo?.from?.id === botInfoUserId;
    const repliedToText = isReplyToBot ? (repliedTo?.text ?? undefined) : undefined;

    const hasNonTextMedia = Boolean(
      ctx.message.photo ||
        ctx.message.video ||
        ctx.message.voice ||
        ctx.message.audio ||
        ctx.message.document ||
        ctx.message.sticker,
    );

    pushRecent(chatId, senderName, text);

    if (text.trim().length < 4) return;
    if (hasNonTextMedia) return;

    const calendarKeywords = /calendar|calend|social media|content|story|stories|reel|conteúdo|publicaç/i;
    let contentCalendar: import("../notion.js").ContentCalendarRow[] | undefined;
    if (calendarKeywords.test(text)) {
      try {
        contentCalendar = await notion.getContentCalendarRows();
      } catch (err) {
        log.warn("pipeline.calendar_fetch_failed", { err: String(err) });
      }
    }

    let openTasks: import("../types.js").OpenTask[] = [];
    try {
      openTasks = await notion.getOpenTasksFor(senderName);
    } catch (err) {
      log.warn("pipeline.open_tasks_fetch_failed", { err: String(err) });
    }

    try {
      const botReplies = await handleAssistant(
        ctx,
        senderName,
        text,
        getPriors(chatId),
        repliedToText,
        contentCalendar,
        lastBotRepliesByChat.get(chatId),
        openTasks,
      );
      if (botReplies.length > 0) {
        lastBotRepliesByChat.set(chatId, botReplies);
      }
    } catch (err) {
      log.error("pipeline.error", { err: String(err) });
      if (errorLimit.tryNotify()) {
        try {
          await ctx.reply(ERROR_MESSAGE);
        } catch (sendErr) {
          log.warn("error_message.send_failed", { err: String(sendErr) });
        }
      }
    }
  });

  bot.catch((err) => {
    log.error("bot.unhandled", {
      err: err.error instanceof Error ? err.error.message : String(err.error),
    });
  });

  botInstance = bot;
  return bot;
}
