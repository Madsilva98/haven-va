/**
 * Weekly "Clientes em risco de churn" digest — src/crons/churn-risk.ts.
 * A full current snapshot, not a delta: "Em risco" names EVERY currently
 * open row, both newly flagged this week and ones already on the list from
 * before — founder's call, 2026-09-28: she wants the whole picture in one
 * message, not just what changed, and no need to see which signal(s) each
 * person has (that detail stays in Notion). "Resolvidos" is a bare count of
 * people who resolved every signal and got archived automatically this run
 * — founder's call, 2026-09-21: no need to name each one individually.
 * Returns null (silent) when nothing happened at all this week.
 */

export interface ChurnDigestEntry {
  nome: string;
}

export function formatChurnDigest(atRisco: ChurnDigestEntry[], resolvedCount = 0): string | null {
  if (atRisco.length === 0 && resolvedCount === 0) return null;

  const lines: string[] = ["*Clientes em risco de churn*"];
  if (atRisco.length > 0) {
    lines.push("", "Em risco:");
    for (const entry of atRisco) lines.push(`• ${entry.nome}`);
  }
  lines.push("", `Resolvidos: ${resolvedCount}`);
  return lines.join("\n");
}
