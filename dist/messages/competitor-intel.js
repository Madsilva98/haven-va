/**
 * Telegram MarkdownV2 digest for the weekly competitor-intel cron — deliberately
 * narrow. Founder's call (2026-09-21): she doesn't want every finding spelled
 * out, only the two kinds worth a fast read — new launches (Tipo
 * "Produto/Serviço") and promotions (Tipo "Promoção/Campanha"). Everything
 * else (events, positioning changes, any new Tipo the extractor proposes)
 * still gets written to Notion in full — this digest just counts it instead
 * of listing it, so the message stays short regardless of how many findings
 * a busy week produces.
 *
 * Filters by Tipo, not by source — keeps working unchanged if a second
 * source (e.g. an Instagram scan, see docs/roadmap.md) starts feeding the
 * same Competitor Intel DB/summary shape later; no digest change needed.
 */
import { escapeMd } from "./cycle.js";
const DIGEST_TIPOS = new Set(["Produto/Serviço", "Promoção/Campanha"]);
export function formatCompetitorIntelDigest(args) {
    const { summary } = args;
    const lines = ["*competitor intel — resumo semanal*"];
    if (summary.errors > 0) {
        lines.push("");
        lines.push(escapeMd(`⚠️ ${summary.errors} email(s) com erro — tentamos de novo na próxima corrida.`));
    }
    const highlightLines = [];
    let highlightCount = 0;
    let otherCount = 0;
    for (const msg of summary.byMessage) {
        const highlights = msg.findings.filter((f) => DIGEST_TIPOS.has(f.tipo));
        otherCount += msg.findings.length - highlights.length;
        if (highlights.length === 0)
            continue;
        highlightLines.push(`*${escapeMd(msg.fromName)}*`);
        for (const f of highlights) {
            highlightLines.push(escapeMd(`• ${f.resumo}`));
            highlightCount++;
        }
    }
    lines.push("");
    if (highlightCount === 0) {
        lines.push(escapeMd("sem lançamentos ou promoções novas esta semana."));
    }
    else {
        lines.push(...highlightLines);
    }
    if (otherCount > 0) {
        lines.push("");
        lines.push(escapeMd(`+ ${otherCount} achado(s) adicional(is) (eventos, posicionamento, etc.) no Notion.`));
    }
    return lines.join("\n").trimEnd();
}
