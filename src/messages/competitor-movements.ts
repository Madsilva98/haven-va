/**
 * Telegram MarkdownV2 message for the Monday competitor-movements cron.
 *
 * Founder's call (2026-10-08): tell the group only about BREAKS — a competitor
 * doing something new against its own strategy or the industry (a new class or
 * format, an offer or price change, a partnership, an event) — never routine
 * posts. The list is decided in haven-comms (competitor_movements.py, from
 * Instagram, websites and the newsletters this bot records in Notion) and lives
 * in the month's watch.json, which is also the dashboard's Competitors page; this
 * message just shows the items found this week, plus a warning when the weekly
 * analysis didn't run, so a silent gap (like 5 Oct 2026) can't go unnoticed.
 * Positioning changes are counted, not listed.
 */

import { escapeMd } from "./cycle.js";
import type { CompetitorInnovation, CompetitorMovementsStatus } from "../types.js";

export const COMPETITORS_PAGE_URL = "https://project-t33mk.vercel.app/competitors";

const GROUPS: [string, string][] = [
  ["Classes & products", "aulas e formatos novos"],
  ["Offers & campaigns", "ofertas e preços"],
  ["Partnerships", "parcerias"],
  ["Events", "eventos"],
];
const STALE_AFTER_DAYS = 6;

export interface CompetitorMovementsArgs {
  today: string; // YYYY-MM-DD, Lisbon
  innovations: CompetitorInnovation[];
  status: CompetitorMovementsStatus | null;
  intelErrors: number; // newsletters the 02:30 extraction couldn't process
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Items the weekly analysis added in the 7 days up to `today`. */
export function thisWeeksMovements(items: CompetitorInnovation[], today: string): CompetitorInnovation[] {
  return items.filter((i) => i.wk && daysBetween(i.wk, today) >= 0 && daysBetween(i.wk, today) < 7);
}

function mdLink(label: string, url: string): string {
  return `[${escapeMd(label)}](${url.replace(/[)\\]/g, (m) => `\\${m}`)})`;
}

function line(i: CompetitorInnovation): string {
  const text = `• *${escapeMd(i.who ?? "?")}* — ${escapeMd(i.pt || i.t)}`;
  return i.url ? `${text} ${mdLink("ver", i.url)}` : text;
}

function warnings(args: CompetitorMovementsArgs): string[] {
  const out: string[] = [];
  const { status, today } = args;
  if (!status || daysBetween(status.date, today) > STALE_AFTER_DAYS) {
    out.push("⚠️ a análise semanal da concorrência não correu esta semana — a lista pode estar incompleta.");
  } else if (!status.ok) {
    const failed = (["instagram", "websites", "newsletters"] as const).filter((s) => status[s] && !status[s].ok);
    const parts = failed.map((s) => ({ instagram: "Instagram", websites: "sites", newsletters: "newsletters" })[s]);
    if (status.failures.length) parts.push(`${status.failures.length} estúdio(s)`);
    out.push(`⚠️ a análise semanal correu com falhas (${parts.join(", ") || "ver status.json"}) — a lista pode estar incompleta.`);
  }
  if (args.intelErrors > 0) {
    out.push(`⚠️ ${args.intelErrors} newsletter(s) com erro — tentamos de novo na próxima segunda.`);
  }
  return out;
}

export function formatCompetitorMovements(args: CompetitorMovementsArgs): string {
  const week = thisWeeksMovements(args.innovations, args.today);
  const lines: string[] = ["*concorrência — movimentos da semana*"];

  const warn = warnings(args);
  if (warn.length) lines.push("", ...warn.map(escapeMd));

  let listed = 0;
  for (const [type, label] of GROUPS) {
    const items = week.filter((i) => i.type === type);
    if (!items.length) continue;
    lines.push("", `*${escapeMd(label)}*`, ...items.map(line));
    listed += items.length;
  }
  if (listed === 0) {
    lines.push("", escapeMd("nada fora do habitual esta semana."));
  }

  const positioning = week.filter((i) => !GROUPS.some(([t]) => t === i.type)).length;
  if (positioning > 0) {
    lines.push("", escapeMd(`+ ${positioning} mudança(s) de posicionamento na página.`));
  }

  lines.push("", `${mdLink("página Competitors", COMPETITORS_PAGE_URL)}`);
  return lines.join("\n");
}
