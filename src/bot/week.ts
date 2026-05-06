/**
 * `/week` ritual — multi-step wizard in DMs.
 *
 *   1. founder types `/week`. Bot fetches her open tasks.
 *   2. Bot shows up to 7 tasks as a togglable inline keyboard.
 *   3. Founder taps to add/remove tasks (state in-memory per user).
 *   4. Founder taps "✅ done picking". Bot validates ≤3, writes
 *      `Prioridade semanal = true` on the picks and `false` on the
 *      rest of her open tasks.
 *   5. Bot asks for the operational focus sentence.
 *   6. Founder replies in plain text. Bot writes to Founder Focus.
 *
 * Wizard state is per-user, in-memory — fine for DMs because each
 * user's flow is independent and a cold start just makes them re-run
 * `/week`. (Phase 1 pending state lives in Notion because button
 * taps need to survive across invocations; here the state can stay
 * ephemeral, since the founder is actively typing.)
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

import { log } from "../lib/log.js";
import { currentWeekLabel } from "../lib/week.js";
import * as notion from "../notion.js";
import type { FounderName, OpenTask, Priority } from "../types.js";

interface WizardState {
  founder: FounderName;
  // taskId → task title (for confirmation rendering)
  candidates: Map<string, OpenTask>;
  selected: Set<string>;
  // Telegram message id of the keyboard message, so we can edit-in-place
  keyboardMessageId: number | null;
  // After the founder taps "done", we wait for free-text focus.
  awaitingFocus: boolean;
  startedAt: number;
}

const PRIORITY_RANK: Record<Priority, number> = {
  Alta: 0,
  Média: 1,
  Baixa: 2,
};

const MAX_TASKS_SHOWN = 7;
const MAX_PICKS = 3;
const STATE_TTL_MS = 30 * 60 * 1000; // 30 min

const wizardByUser = new Map<number, WizardState>();

function gcStale(): void {
  const now = Date.now();
  for (const [userId, st] of wizardByUser) {
    if (now - st.startedAt > STATE_TTL_MS) wizardByUser.delete(userId);
  }
}

export function isWeekCommand(text: string): boolean {
  return /^\/week(@\w+)?\b/i.test(text);
}

export function isWeekCallback(data: string): boolean {
  return data.startsWith("week:");
}

export function isAwaitingFocusFor(userId: number): boolean {
  const st = wizardByUser.get(userId);
  return Boolean(st && st.awaitingFocus);
}

function rankTasks(tasks: OpenTask[]): OpenTask[] {
  return [...tasks].sort((a, b) => {
    const pa = a.priority ? PRIORITY_RANK[a.priority] : 3;
    const pb = b.priority ? PRIORITY_RANK[b.priority] : 3;
    if (pa !== pb) return pa - pb;
    const da = a.deadline ?? "9999-12-31";
    const db = b.deadline ?? "9999-12-31";
    if (da < db) return -1;
    if (da > db) return 1;
    return 0;
  });
}

function buttonLabel(t: OpenTask, picked: boolean): string {
  const box = picked ? "☑️" : "⬜️";
  const areaShort = t.area.toLowerCase();
  const prio = t.priority ? t.priority.toLowerCase() : "—";
  // Telegram button labels truncate ~64 chars; keep title short.
  const title = t.title.length > 32 ? t.title.slice(0, 31) + "…" : t.title;
  return `${box} ${title} (${areaShort}, ${prio})`;
}

function renderKeyboard(state: WizardState): InlineKeyboard {
  const kb = new InlineKeyboard();
  let i = 0;
  for (const [taskId, task] of state.candidates) {
    const picked = state.selected.has(taskId);
    kb.text(buttonLabel(task, picked), `week:toggle:${taskId}`);
    kb.row();
    i++;
    if (i >= MAX_TASKS_SHOWN) break;
  }
  kb.text("✅ done picking", "week:done");
  kb.text("❌ cancelar", "week:cancel");
  return kb;
}

function summary(state: WizardState): string {
  const n = state.selected.size;
  return `escolhe até ${MAX_PICKS} prioridades para esta semana. selecionadas: ${n}/${MAX_PICKS}`;
}

export async function handleWeek(
  ctx: Context,
  founder: FounderName,
): Promise<void> {
  gcStale();

  const tasks = await notion.getOpenTasksFor(founder);
  if (tasks.length === 0) {
    await ctx.reply(
      "ainda não tens tasks no backlog. cria algumas primeiro.",
    );
    return;
  }
  const ranked = rankTasks(tasks).slice(0, MAX_TASKS_SHOWN);
  const candidates = new Map<string, OpenTask>();
  for (const t of ranked) candidates.set(t.id, t);

  const state: WizardState = {
    founder,
    candidates,
    selected: new Set(),
    keyboardMessageId: null,
    awaitingFocus: false,
    startedAt: Date.now(),
  };

  const sent = await ctx.reply(summary(state), {
    reply_markup: renderKeyboard(state),
  });
  state.keyboardMessageId = sent.message_id;

  const userId = ctx.from?.id;
  if (userId) wizardByUser.set(userId, state);
}

export async function handleWeekCallback(
  ctx: Context,
  founder: FounderName,
): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const userId = ctx.from?.id;
  if (!userId) return;

  const state = wizardByUser.get(userId);
  if (!state || state.founder !== founder) {
    await ctx.answerCallbackQuery({ text: "sessão expirada — corre /week outra vez" });
    return;
  }

  if (data === "week:cancel") {
    wizardByUser.delete(userId);
    await ctx.answerCallbackQuery({ text: "cancelado" });
    try {
      await ctx.editMessageText("cancelado.");
    } catch {
      /* message may be too old to edit */
    }
    return;
  }

  if (data.startsWith("week:toggle:")) {
    const taskId = data.slice("week:toggle:".length);
    if (!state.candidates.has(taskId)) {
      await ctx.answerCallbackQuery({ text: "task não está nesta lista" });
      return;
    }
    if (state.selected.has(taskId)) {
      state.selected.delete(taskId);
    } else {
      if (state.selected.size >= MAX_PICKS) {
        await ctx.answerCallbackQuery({
          text: `máximo ${MAX_PICKS} — tira uma antes`,
        });
        return;
      }
      state.selected.add(taskId);
    }
    try {
      await ctx.editMessageText(summary(state), {
        reply_markup: renderKeyboard(state),
      });
    } catch (err) {
      log.warn("week.edit_failed", { err: String(err) });
    }
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "week:done") {
    if (state.selected.size === 0) {
      await ctx.answerCallbackQuery({ text: "escolhe pelo menos uma" });
      return;
    }
    if (state.selected.size > MAX_PICKS) {
      await ctx.answerCallbackQuery({
        text: `máximo ${MAX_PICKS} — tira algumas`,
      });
      return;
    }

    await ctx.answerCallbackQuery({ text: "a guardar..." });

    // Apply: set Prioridade semanal=true on picked, =false on the rest of her open tasks.
    let hadFailures = false;
    try {
      const allOpen = await notion.getOpenTasksFor(founder);
      const writes = allOpen.map((t) =>
        notion.setWeeklyPriority(t.id, state.selected.has(t.id)),
      );
      const results = await Promise.allSettled(writes);
      const failed = results.filter((r) => r.status === "rejected");
      if (failed.length > 0) {
        log.error("week.set_priorities_partial_failure", {
          failed: failed.length,
          total: writes.length,
        });
        hadFailures = true;
      }
    } catch (err) {
      log.error("week.set_priorities_failed", { err: String(err) });
      try {
        await ctx.editMessageText("erro a guardar — tenta outra vez");
      } catch {
        /* ignore */
      }
      wizardByUser.delete(userId);
      return;
    }

    state.awaitingFocus = true;
    state.startedAt = Date.now(); // reset TTL
    const suffix = hadFailures ? " (algumas não guardaram — verifica o Notion)" : "";
    try {
      await ctx.editMessageText(
        `prioridades guardadas (${state.selected.size})${suffix}. qual o teu foco operacional desta semana? (uma frase)`,
      );
    } catch {
      await ctx.reply(
        `prioridades guardadas (${state.selected.size})${suffix}. qual o teu foco operacional desta semana? (uma frase)`,
      );
    }
    return;
  }

  await ctx.answerCallbackQuery();
}

export async function handleWeekTextStep(
  ctx: Context,
  founder: FounderName,
  text: string,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const state = wizardByUser.get(userId);
  if (!state || !state.awaitingFocus) return;

  const focus = text.trim();
  if (focus.length === 0) {
    await ctx.reply("escreve uma frase para o foco da semana");
    return;
  }

  try {
    await notion.setFounderFocus({
      founder,
      semana: currentWeekLabel(),
      focoOperacional: focus,
    });
  } catch (err) {
    log.error("week.set_focus_failed", { err: String(err) });
    await ctx.reply(
      "não consegui guardar o foco — tenta outra vez com /focus <texto>",
    );
    wizardByUser.delete(userId);
    return;
  }

  wizardByUser.delete(userId);
  await ctx.reply("foco guardado. boa semana 🩵");
}
