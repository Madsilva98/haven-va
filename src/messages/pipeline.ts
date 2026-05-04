/**
 * Phase 3 — pipeline alert formatters.
 *
 * All output is pt-PT, "tu", lowercase preferred, terse.
 * Used by the cron pipeline-alerts handler before sending DMs to owners.
 */

import type { InfluencerRow, PartnerRow, ReminderRow } from "../types.js";

function statusOrDash(s: string | null | undefined): string {
  return s && s.trim().length > 0 ? s.toLowerCase() : "—";
}

function quoteDraft(draft: string): string {
  // Telegram-friendly blockquote-ish formatting using "> " line prefix.
  const trimmed = draft.trim();
  if (trimmed.length === 0) return "";
  return trimmed
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function formatPartnerAlert(
  row: PartnerRow,
  daysSinceContact: number,
  suggestedFollowup: string,
): string {
  const lines: string[] = [];
  lines.push(`🤝 parceria parada: ${row.nome}`);
  lines.push(`status: ${statusOrDash(row.status)} · ${daysSinceContact}d sem contacto`);
  if (row.proximoPasso && row.proximoPasso.trim().length > 0) {
    lines.push(`próximo passo: ${row.proximoPasso}`);
  }
  lines.push("");
  lines.push("sugestão de follow-up:");
  lines.push(quoteDraft(suggestedFollowup));
  return lines.join("\n");
}

export function formatInfluencerAlert(
  row: InfluencerRow,
  daysSinceContact: number,
  suggestedFollowup: string,
): string {
  const lines: string[] = [];
  const handle = row.instagram ? ` (${row.instagram})` : "";
  lines.push(`📸 influencer parada: ${row.nome}${handle}`);
  lines.push(
    `status: ${statusOrDash(row.status)} · ${daysSinceContact}d sem contacto`,
  );
  if (row.proximoPasso && row.proximoPasso.trim().length > 0) {
    lines.push(`próximo passo: ${row.proximoPasso}`);
  }
  lines.push("");
  lines.push("sugestão de follow-up:");
  lines.push(quoteDraft(suggestedFollowup));
  return lines.join("\n");
}

export function formatContentAlert(buckets: {
  hours_to_publish_unscheduled: unknown[];
  editing_too_long: unknown[];
  ideation_stale: unknown[];
}): string {
  const a = buckets.hours_to_publish_unscheduled.length;
  const b = buckets.editing_too_long.length;
  const c = buckets.ideation_stale.length;
  const lines: string[] = ["📅 content calendar:"];
  if (a > 0) lines.push(`• ${a} a publicar em <24h sem agendamento`);
  if (b > 0) lines.push(`• ${b} em edição há >48h da publicação`);
  if (c > 0) lines.push(`• ${c} em ideação há >14d`);
  if (a === 0 && b === 0 && c === 0) lines.push("• tudo a andar 👌");
  return lines.join("\n");
}

export function formatReminderMessage(r: ReminderRow): string {
  const lines: string[] = [`⏰ ${r.texto}`];
  if (r.origem && r.origem.trim().length > 0) {
    // single-line context
    const ctx = r.origem.replace(/\s+/g, " ").trim();
    lines.push(`(do que disseste: "${ctx}")`);
  }
  return lines.join("\n");
}
