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
export function formatChurnDigest(atRisco, resolvedCount = 0, 
// Set when the cron's circuit breaker stopped the weekly cleanup — see
// isSuspiciousChurnSweep in src/crons/churn-risk.ts.
brake = null) {
    if (atRisco.length === 0 && resolvedCount === 0 && !brake)
        return null;
    const lines = ["*Clientes em risco de churn*"];
    if (brake) {
        lines.push("", `⚠️ Esta semana ${brake.wouldArchive} de ${brake.open} clientes da lista deixaram de aparecer como em risco — ` +
            `é mais do que o normal, por isso não arquivei ninguém (as notas ficam intactas). ` +
            `Pode ser um problema nos dados do estúdio. Se estiverem mesmo resolvidos, marca-os como Resolvido e saem na próxima segunda.`);
    }
    if (atRisco.length > 0) {
        lines.push("", "Em risco:");
        for (const entry of atRisco)
            lines.push(`• ${entry.nome}`);
    }
    lines.push("", `Resolvidos: ${resolvedCount}`);
    return lines.join("\n");
}
