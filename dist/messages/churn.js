/**
 * Weekly "Clientes em risco de churn" digest — src/crons/churn-risk.ts.
 * Only lists people newly flagged or who gained a new signal this week;
 * rows already open in Notion from a prior week are the founder's manual
 * follow-up, not re-nagged here. Returns null (silent) when nothing changed.
 */
export function formatChurnDigest(entries) {
    if (entries.length === 0)
        return null;
    const lines = [`⚠️ *${entries.length} cliente(s) em risco de churn:*`];
    for (const entry of entries) {
        lines.push(`• ${entry.nome} — ${entry.sinais.join(", ")}`);
    }
    return lines.join("\n");
}
