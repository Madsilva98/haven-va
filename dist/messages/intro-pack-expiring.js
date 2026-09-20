/**
 * Daily digest of still-active intro packs expiring soon, grouped by the
 * two usage patterns src/lib/intro-pack-conversion.ts's
 * findExpiringIntroPacksToWatch already filtered for. Returns null (no
 * message sent) when nobody matches, same contract as the other digests.
 */
const TWO_CLASSES_NAMES = new Set(["2 Classes + Free Socks | Premium", "2 Classes | Premium"]);
function formatDate(d) {
    return d.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
}
export function formatExpiringIntroPacksDigest(packs) {
    if (packs.length === 0)
        return null;
    const twoClasses = packs.filter((p) => TWO_CLASSES_NAMES.has(p.packName));
    const tenDay = packs.filter((p) => !TWO_CLASSES_NAMES.has(p.packName));
    const lines = ["📦 *Intro packs a terminar nos próximos 3 dias:*"];
    if (twoClasses.length > 0) {
        lines.push("", "2 Classes — só usaram 1 aula:");
        for (const p of twoClasses) {
            lines.push(`• ${p.name} — termina ${formatDate(p.expiresAt)}${p.phone ? ` (${p.phone})` : ""}`);
        }
    }
    if (tenDay.length > 0) {
        lines.push("", "10-Day Unlimited — já fizeram mais de 5 aulas:");
        for (const p of tenDay) {
            lines.push(`• ${p.name} — termina ${formatDate(p.expiresAt)}, ${p.visitCount} aulas${p.phone ? ` (${p.phone})` : ""}`);
        }
    }
    return lines.join("\n");
}
