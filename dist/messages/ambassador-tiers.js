/**
 * The group's ambassador note, one per Kenko import with news (Madalena,
 * 2026-10-15): an informative part ("O que mudou" between imports, and the
 * count on the 1st once an import covers it) and an action part ("A fazer":
 * who to tell, which discount to change in Kenko). Plain text, not addressed
 * to anyone in particular — any founder can act on it. Null = nothing to say.
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
function ddmmyyyy(date) {
    return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}
function pessoas(n) {
    return n === 1 ? "1 pessoa" : `${n} pessoas`;
}
function nameFor(id, names) {
    return names.get(id) ?? `sem nome (${id.slice(0, 8)})`;
}
function list(items) {
    return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}
const REASON = {
    cancelou: " (cancelou)",
    expirou: " (a membership expirou)",
    pausou: " (em pausa)",
    saiu: "",
};
function referredParts(n, names, withReasons) {
    const parts = [];
    if (n.entered.length > 0) {
        parts.push(`${n.entered.length === 1 ? "entrou" : "entraram"} ${list(n.entered.map((id) => nameFor(id, names)))}`);
    }
    if (n.left.length > 0) {
        const who = n.left.map((l) => nameFor(l.id, names) + (withReasons ? REASON[l.reason] : ""));
        parts.push(`${n.left.length === 1 ? "saiu" : "saíram"} ${list(who)}`);
    }
    if (n.cancelScheduled.length > 0) {
        const who = list(n.cancelScheduled.map((id) => nameFor(id, names)));
        parts.push(`${who} ${n.cancelScheduled.length === 1 ? "agendou" : "agendaram"} o cancelamento`);
    }
    return parts;
}
function newsLines(lines, names) {
    const out = [];
    const sorted = [...lines].sort((a, b) => nameFor(a.news.ambassadorId, names).localeCompare(nameFor(b.news.ambassadorId, names), "pt"));
    for (const { news: n, effect, scheduledEffect, nextCount } of sorted) {
        const amb = nameFor(n.ambassadorId, names);
        const parts = referredParts(n, names, true);
        if (parts.length > 0) {
            const moved = n.entered.length + n.left.length > 0;
            const count = moved ? `${pessoas(n.countNow)}.` : `${pessoas(n.countNow)} por agora.`;
            const tail = [moved ? effect : null, scheduledEffect].filter(Boolean).join(" ");
            out.push(`· ${amb}: ${parts.join("; ")} → ${count}${tail ? ` ${tail}` : ""}`);
        }
        if (n.selfLeft) {
            out.push(`· ${amb} deixou de ser membro: perde o desconto na contagem de ${nextCount}.`);
        }
        else if (n.selfCancelScheduled) {
            out.push(`· ${amb} agendou o cancelamento da própria membership: perde o desconto se não renovar até ${nextCount}.`);
        }
    }
    return out;
}
function tierSection(title, changes, names, line) {
    if (changes.length === 0)
        return [];
    const sorted = [...changes].sort((a, b) => nameFor(a.memberId, names).localeCompare(nameFor(b.memberId, names), "pt"));
    return [title, ...sorted.map((c) => `· ${nameFor(c.memberId, names)}: ${line(c)}`)];
}
/** The count on the 1st — who moved tier. [] when nothing changed. */
export function monthlyCountLines(plan, monthStart, names) {
    const moved = (c) => `${c.fromLabel ?? "sem desconto"} → ${c.toLabel} (${pessoas(c.activeReferred)})`;
    const sections = [
        tierSection("Subiram", plan.up, names, moved),
        tierSection("Desceram", plan.down, names, moved),
        tierSection("Novos", plan.new, names, (c) => `${c.toLabel} (${pessoas(c.activeReferred)})`),
        tierSection("Deixam de ter desconto", plan.left, names, (c) => c.isMember
            ? `${c.fromLabel} → sem desconto (${pessoas(c.activeReferred)})`
            : `${c.fromLabel} → sem desconto (já não é membro)`),
    ].filter((s) => s.length > 0);
    if (sections.length === 0)
        return [];
    return [`Contagem de ${monthStartLabel(monthStart)}`, ...sections.flatMap((s, i) => (i === 0 ? s : ["", ...s]))];
}
function kenkoActions(plan, names) {
    const all = [...plan.up, ...plan.down, ...plan.new, ...plan.left].sort((a, b) => nameFor(a.memberId, names).localeCompare(nameFor(b.memberId, names), "pt"));
    return all.map((c) => `· Mudar no Kenko, no próximo pagamento: ${nameFor(c.memberId, names)} ${c.fromLabel ?? "sem desconto"} → ${c.toLabel ?? "sem desconto"}`);
}
export function formatAmbassadorMessage(input) {
    const { asOf, news, monthly, names } = input;
    const changed = newsLines(news, names);
    const count = monthly ? monthlyCountLines(monthly.plan, monthly.monthStart, names) : [];
    const tell = [...news]
        .sort((a, b) => nameFor(a.news.ambassadorId, names).localeCompare(nameFor(b.news.ambassadorId, names), "pt"))
        .map((l) => ({ amb: nameFor(l.news.ambassadorId, names), parts: referredParts(l.news, names, false) }))
        .filter((t) => t.parts.length > 0)
        .map((t) => `· Avisar ${t.amb}: ${t.parts.join("; ")}`);
    const todo = [...tell, ...(monthly ? kenkoActions(monthly.plan, names) : [])];
    if (changed.length === 0 && count.length === 0)
        return null;
    const out = [`Embaixadores · dados até ${ddmmyyyy(asOf)}`];
    if (changed.length > 0)
        out.push("", "O que mudou", ...changed);
    if (count.length > 0)
        out.push("", ...count);
    if (todo.length > 0)
        out.push("", "A fazer", ...todo);
    return out.join("\n");
}
