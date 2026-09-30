/**
 * Daily digest of still-active intro packs worth a same-day nudge, grouped
 * by the 4 reasons `src/lib/pulse-views.ts`'s `fetchIntroPackWatch` already
 * qualified rows for (src/lib/intro-pack-conversion.ts's
 * findExpiringIntroPacksToWatch just shapes the rows, it doesn't re-derive
 * the reason). Returns null (no message sent) when nobody matches, same
 * contract as the other digests.
 *
 * No single top-level "next N days" claim — the buckets don't share one
 * window (found 2026-09-30, right after the 2-Class window first changed
 * from a flat 3 days to "this week": a leftover top-level claim was wrong
 * for whichever bucket didn't match it). Each section states its own
 * timing instead.
 */
function formatDate(d) {
    return d.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
}
function formatDatePt(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
}
export function formatExpiringIntroPacksDigest(packs) {
    if (packs.length === 0)
        return null;
    const unusedEnding = packs.filter((p) => p.reason === "unused_ending");
    const completedFollowup = packs.filter((p) => p.reason === "completed_followup");
    const ending = packs.filter((p) => p.reason === "ending");
    const underused = packs.filter((p) => p.reason === "underused");
    const lines = ["📦 *Intro packs a terminar em breve:*"];
    if (unusedEnding.length > 0) {
        lines.push("", "2 Classes — ainda não fizeram a 2ª aula, poucos dias para terminar:");
        for (const p of unusedEnding) {
            lines.push(`• ${p.name} — termina ${formatDate(p.expiresAt)}${p.phone ? ` (${p.phone})` : ""}`);
        }
    }
    if (completedFollowup.length > 0) {
        lines.push("", "2 Classes — já fizeram as duas aulas, bom momento para follow-up:");
        for (const p of completedFollowup) {
            const secondClass = p.lastVisitOn ? ` — 2ª aula em ${formatDatePt(p.lastVisitOn)}` : "";
            lines.push(`• ${p.name}${secondClass}${p.phone ? ` (${p.phone})` : ""}`);
        }
    }
    if (ending.length > 0) {
        lines.push("", "10-Day Unlimited — a terminar em breve:");
        for (const p of ending) {
            lines.push(`• ${p.name} — termina ${formatDate(p.expiresAt)}, ${p.visitCount} aulas do pack${p.phone ? ` (${p.phone})` : ""}`);
        }
    }
    if (underused.length > 0) {
        lines.push("", "10-Day Unlimited — pouca utilização (5 dias desde a 1ª aula):");
        for (const p of underused) {
            const since = p.firstVisitOn ? ` desde ${formatDatePt(p.firstVisitOn)}` : "";
            lines.push(`• ${p.name} — só ${p.visitCount} aula(s)${since}${p.phone ? ` (${p.phone})` : ""}`);
        }
    }
    return lines.join("\n");
}
