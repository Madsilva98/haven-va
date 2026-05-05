import { currentWeekLabel } from "../lib/week.js";
import { escapeMd } from "./cycle.js";
const URGENCY_EMOJI = {
    "Urgente": "🔴",
    "Precisa de decisão rápida": "🟡",
    "Pode esperar": "🟢",
};
const FOUNDERS = ["Madalena", "Mafalda", "Beatriz"];
export function formatDashboard({ focus, toDiscuss }) {
    const lines = [];
    lines.push(`*dashboard — ${escapeMd(currentWeekLabel())}*`);
    lines.push("");
    lines.push("*foco das founders*");
    for (const name of FOUNDERS) {
        const entry = focus.find((f) => f.founder === name);
        const foco = entry?.focoOperacional?.trim() || "—";
        lines.push(`• *${escapeMd(name)}*: ${escapeMd(foco)}`);
    }
    lines.push("");
    if (toDiscuss.length === 0) {
        lines.push("*para discutir* — nada pendente ✅");
    }
    else {
        lines.push(`*para discutir* \\(${toDiscuss.length} pendentes\\)`);
        for (const item of toDiscuss) {
            const emoji = URGENCY_EMOJI[item.urgencia] ?? "🟢";
            lines.push(`${emoji} ${escapeMd(item.tema)} — ${escapeMd(item.adicionadoPor)}`);
        }
    }
    return lines.join("\n");
}
