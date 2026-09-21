/**
 * Telegram MarkdownV2 digest for the weekly competitor-intel cron — one
 * message combining both the tidy phase (what got archived) and the
 * process phase (what got extracted into Notion), grouped by sender.
 */
import { escapeMd } from "./cycle.js";
export function formatCompetitorIntelDigest(args) {
    const { tidiedCount, summary } = args;
    const lines = [];
    lines.push("*competitor intel — resumo semanal*");
    lines.push("");
    lines.push(escapeMd(`${tidiedCount} email(s) arquivado(s), ${summary.messagesProcessed} processado(s), ${summary.findingsWritten} achado(s) novo(s) no Notion.`));
    if (summary.errors > 0) {
        lines.push(escapeMd(`⚠️ ${summary.errors} email(s) com erro — ficam por processar, tentamos de novo na próxima corrida.`));
    }
    if (summary.byMessage.length === 0) {
        lines.push("");
        lines.push(escapeMd("nada de novo esta semana."));
        return lines.join("\n");
    }
    lines.push("");
    for (const msg of summary.byMessage) {
        if (msg.findings.length === 0)
            continue;
        lines.push(`*${escapeMd(msg.fromName)}*`);
        for (const f of msg.findings) {
            lines.push(escapeMd(`• [${f.tipo}] ${f.resumo}`));
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
