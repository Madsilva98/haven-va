/**
 * The group's monthly ambassador note: who moved up or down a tier on the
 * 1st, who is new, whose discount stops — so Bia changes it in Kenko at
 * their next payment. Plain text. Null = nothing changed, no message
 * (founder preference).
 */
const MONTHS = [
    "janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
/** "2026-11-01" → "1 de novembro". */
export function monthStartLabel(monthStart) {
    const m = Number(monthStart.slice(5, 7));
    const d = Number(monthStart.slice(8, 10));
    return `${d} de ${MONTHS[m - 1]}`;
}
function pessoas(n) {
    return n === 1 ? "1 pessoa" : `${n} pessoas`;
}
function nameOf(c, names) {
    return names.get(c.memberId) ?? `sem nome (${c.memberId.slice(0, 8)})`;
}
function section(title, changes, names, line) {
    if (changes.length === 0)
        return [];
    const sorted = [...changes].sort((a, b) => nameOf(a, names).localeCompare(nameOf(b, names), "pt"));
    return ["", title, ...sorted.map((c) => `· ${nameOf(c, names)}: ${line(c)}`)];
}
export function formatAmbassadorTierChanges(plan, monthStart, names) {
    const moved = (c) => `${c.fromLabel ?? "sem desconto"} → ${c.toLabel} (${pessoas(c.activeReferred)})`;
    const body = [
        ...section("Subiram", plan.up, names, moved),
        ...section("Desceram", plan.down, names, moved),
        ...section("Novos", plan.new, names, (c) => `${c.toLabel} (${pessoas(c.activeReferred)})`),
        ...section("Deixam de ter desconto", plan.left, names, (c) => c.isMember
            ? `${c.fromLabel} → sem desconto (${pessoas(c.activeReferred)})`
            : `${c.fromLabel} → sem desconto (já não é membro)`),
    ];
    if (body.length === 0)
        return null;
    return [
        `Embaixadores · contagem de ${monthStartLabel(monthStart)}`,
        ...body,
        "",
        "A Bia muda o desconto no Kenko no próximo pagamento de cada pessoa.",
    ].join("\n");
}
