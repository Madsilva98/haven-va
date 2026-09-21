/**
 * Weekly "Clientes em risco de churn" digest — src/crons/churn-risk.ts.
 * Lists people newly flagged, or who gained/lost a signal but still have at
 * least one open (still worth watching or contacting by name); rows already
 * open in Notion from a prior week with nothing new are the founder's manual
 * follow-up, not re-nagged here. People who resolved EVERY signal get
 * archived automatically and are only ever summarised as a count — the
 * founder's call (2026-09-21): no need to name each one individually.
 * Returns null (silent) when nothing happened at all this week.
 */
export function formatChurnDigest(entries, resolvedCount = 0) {
    if (entries.length === 0 && resolvedCount === 0)
        return null;
    const lines = [];
    if (entries.length > 0) {
        lines.push(`⚠️ *${entries.length} cliente(s) em risco de churn:*`);
        for (const entry of entries) {
            lines.push(`• ${entry.nome} — ${entry.sinais.join(", ")}`);
        }
    }
    if (resolvedCount > 0) {
        lines.push(`✅ ${resolvedCount} resolvida(s) esta semana (sem sinais de risco, arquivadas automaticamente).`);
    }
    return lines.join("\n");
}
