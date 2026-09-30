/**
 * Decides which record a free-text request ("tira o leite da lista",
 * "cancela o lembrete da renda") refers to, before the assistant DELETES
 * something — and when it isn't sure, says so instead of guessing.
 *
 * Founder's call (2026-09-29, failsafe-audit-2026-09-29.md): deleteListItem
 * used to archive the best fuzzy match with ANY score above 0 (one shared
 * word was enough), and cancelReminder took whichever reminder happened to
 * come back first among several that contained the text. Both now ask.
 */
// A match at or above this is "clearly the same item" (exact, or one title
// contains the other, or at least half the words overlap).
const STRONG = 0.5;
const MAX_OPTIONS = 5;
function wordOverlap(a, b) {
    const wa = new Set(a.split(/\s+/).filter(Boolean));
    const wb = new Set(b.split(/\s+/).filter(Boolean));
    if (!wa.size || !wb.size)
        return 0;
    let overlap = 0;
    for (const w of wa)
        if (wb.has(w))
            overlap++;
    return overlap / Math.max(wa.size, wb.size);
}
export function scoreTitle(query, title) {
    const q = query.toLowerCase().trim();
    const t = title.toLowerCase().trim();
    // An empty title would otherwise "contain" every query.
    if (!q || !t)
        return 0;
    if (t === q)
        return 1;
    if (t.includes(q) || q.includes(t))
        return 0.8;
    return wordOverlap(q, t);
}
/**
 * - one exact match (or several identical titles — interchangeable) → match
 * - exactly one strong match → match
 * - several strong matches, or only weak ones → ambiguous (ask which)
 * - nothing shares a word → none
 */
export function pickMatch(query, candidates) {
    const scored = candidates
        .map((c) => ({ ...c, score: scoreTitle(query, c.title) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);
    if (scored.length === 0)
        return { kind: "none" };
    const exact = scored.filter((c) => c.score === 1);
    if (exact.length > 0)
        return { kind: "match", id: exact[0].id, title: exact[0].title };
    const strong = scored.filter((c) => c.score >= STRONG);
    if (strong.length === 1)
        return { kind: "match", id: strong[0].id, title: strong[0].title };
    const options = (strong.length > 1 ? strong : scored).slice(0, MAX_OPTIONS);
    return { kind: "ambiguous", titles: options.map((c) => c.title) };
}
