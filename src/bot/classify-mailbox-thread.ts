/**
 * Claude Haiku classifier for the tidy-mailboxes cron: decides whether an
 * inbox email thread still needs a reply/action from the Haven, or is
 * resolved and safe to archive.
 *
 * This runs fully unattended (no human review before archiving), so it
 * fails safe: any error, empty response, or unparseable answer defaults to
 * "needs_action" — leaving the email in the Inbox is the low-cost mistake,
 * archiving something that actually needed a reply is the expensive one.
 */

import Anthropic from "@anthropic-ai/sdk";

import { log } from "../lib/log.js";

const MODEL = "claude-haiku-4-5";
const MAX_BODY_CHARS = 6000; // keep the top of the thread — newest reply first, older quoted below

const SYSTEM_INSTRUCTION =
  "Analisas emails de um estúdio de Pilates (The Haven) para decidir se uma thread ainda precisa de resposta/ação da equipa, ou se está resolvida e pode ser arquivada. " +
  "Considera resolvida: perguntas já respondidas sem necessidade de confirmação adicional, agradecimentos finais, newsletters/notificações automáticas sem pedido, spam/marketing. " +
  "Considera que precisa de ação: uma pergunta do cliente ainda sem resposta da equipa, um pedido em aberto, algo que claramente espera uma resposta e a última mensagem na thread não é da equipa do Haven a fechar o assunto. " +
  'Na dúvida, escolhe NEEDS_ACTION — o custo de deixar algo na Inbox por engano é muito menor do que arquivar algo que precisava de resposta. ' +
  "Responde EXATAMENTE neste formato, nada mais:\nDECISÃO: NEEDS_ACTION ou NO_ACTION_NEEDED\nRAZÃO: uma frase curta em pt-PT";

export interface ThreadClassification {
  needsAction: boolean;
  reason: string;
}

function fallback(reason: string): ThreadClassification {
  return { needsAction: true, reason };
}

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    log.warn("classify_mailbox_thread.no_api_key");
    return null;
  }
  client = new Anthropic({ apiKey: key });
  return client;
}

function buildUserPrompt(params: {
  mailbox: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  body: string;
}): string {
  const body = params.body.slice(0, MAX_BODY_CHARS);
  return [
    `Caixa: ${params.mailbox}`,
    `De: ${params.fromName} <${params.fromEmail}>`,
    `Assunto: ${params.subject}`,
    "",
    body,
  ].join("\n");
}

export async function classifyMailboxThread(params: {
  mailbox: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  body: string;
}): Promise<ThreadClassification> {
  const c = getClient();
  if (!c) return fallback("sem ANTHROPIC_API_KEY — assumido NEEDS_ACTION por segurança");

  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: [
        {
          type: "text",
          text: SYSTEM_INSTRUCTION,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: buildUserPrompt(params) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const decisionMatch = text.match(/DECIS[ÃA]O:\s*(NEEDS_ACTION|NO_ACTION_NEEDED)/i);
    const reasonMatch = text.match(/RAZ[ÃA]O:\s*(.+)/i);

    if (!decisionMatch) {
      log.warn("classify_mailbox_thread.unparseable_response", { text: text.slice(0, 200) });
      return fallback("resposta do modelo não reconhecida — assumido NEEDS_ACTION por segurança");
    }

    return {
      needsAction: (decisionMatch[1] ?? "").toUpperCase() === "NEEDS_ACTION",
      reason: reasonMatch?.[1]?.trim() ?? "(sem razão)",
    };
  } catch (err) {
    log.warn("classify_mailbox_thread.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return fallback("erro na classificação — assumido NEEDS_ACTION por segurança");
  }
}
