/**
 * Daily Telegram note for the "Tracking intro packs" list: only who joined
 * the list on this run and who converted to a membership (founder's call,
 * 2026-10-02 — no link, no other exits). Null = nothing new, no message.
 */
function aulas(n) {
    return n === 1 ? "1 aula" : `${n} aulas`;
}
export function formatIntroTrackingDigest(created, converted) {
    if (created.length === 0 && converted.length === 0)
        return null;
    const lines = [];
    if (created.length > 0) {
        lines.push("📦 *Intro packs — novos na lista:*");
        for (const c of created) {
            const f = c.fields;
            lines.push(`• ${c.name} — ${f.motivo}, ${f.pack}, ${aulas(f.aulasFeitas)} feita(s)` +
                (f.aulasMarcadas > 0 ? `, ${aulas(f.aulasMarcadas)} marcada(s)` : "") +
                (f.telefone ? ` (${f.telefone})` : ""));
        }
    }
    if (converted.length > 0) {
        if (lines.length > 0)
            lines.push("");
        lines.push("🎉 *Converteram para mensalidade:*");
        for (const name of converted)
            lines.push(`• ${name}`);
    }
    return lines.join("\n");
}
