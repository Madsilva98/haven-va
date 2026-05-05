import Anthropic from "@anthropic-ai/sdk";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const QUERY_RE = /^(quais?|diz[- ]me|mostra|lista|quantas?|quem (tem|está|ficou|fica)|há |tens?|tenho|como (está|estão)|o que (está|temos|há)|qual|quando (é|são|temos))\b|\?$/iu;
export function isQuery(text) {
    return QUERY_RE.test(text.trim());
}
const SYSTEM_PROMPT = `És a Haven VA, assistente das founders do Haven (estúdio de pilates, Carcavelos, pt-PT).
Responde em pt-PT, informal, conciso. Usa listas quando listares múltiplos itens.
Se não tiveres dados suficientes para responder, diz isso claramente. Nunca inventes dados.`;
let client = null;
function getClient() {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error("ANTHROPIC_API_KEY is not set");
        client = new Anthropic({ apiKey });
    }
    return client;
}
export async function handleQuery(ctx, question, _sender) {
    try {
        const [tasks, decisions, toDiscuss] = await Promise.all([
            notion.getOpenTasks().catch(() => []),
            notion.getRecentDecisions(15).catch(() => []),
            notion.getToDiscussPending().catch(() => []),
        ]);
        const lines = [];
        if (tasks.length > 0) {
            lines.push("Tasks em aberto:");
            for (const t of tasks) {
                const deadline = t.deadline ? `, deadline: ${t.deadline}` : "";
                lines.push(`  - [${t.area}] "${t.title}" — ${t.owner}, ${t.status}${deadline}`);
            }
        }
        else {
            lines.push("Tasks em aberto: nenhuma.");
        }
        if (decisions.length > 0) {
            lines.push("\nDecisões recentes:");
            for (const d of decisions) {
                lines.push(`  - ${d.decisao} (${d.data ?? "sem data"})`);
            }
        }
        if (toDiscuss.length > 0) {
            lines.push("\nPara discutir:");
            for (const td of toDiscuss) {
                lines.push(`  - [${td.urgencia}] ${td.tema} — ${td.adicionadoPor}`);
            }
        }
        const context = lines.join("\n");
        const response = await getClient().messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [
                {
                    role: "user",
                    content: `Dados actuais:\n${context}\n\nPergunta: ${question}`,
                },
            ],
        });
        const answer = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
        if (!answer) {
            log.warn("query.empty_response");
            return;
        }
        log.info("query.answered", { question: question.slice(0, 60) });
        await ctx.reply(answer);
    }
    catch (err) {
        log.error("query.failed", { err: String(err) });
        await ctx.reply("não consegui responder — tenta outra vez");
    }
}
