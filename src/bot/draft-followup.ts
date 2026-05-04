/**
 * Phase 3 — Claude Haiku follow-up message drafter.
 *
 * Single short call (max 200 tokens) to generate a friendly pt-PT
 * follow-up message for a stale partner or influencer row. Uses
 * prompt caching on the system instruction so repeated calls within
 * the same cron run benefit from a hot cache.
 *
 * On any error (no API key, network, rate limit) returns a deterministic
 * fallback string so the cron job never fails because of LLM hiccups.
 */

import Anthropic from "@anthropic-ai/sdk";

import { log } from "../lib/log.js";
import type { InfluencerRow, PartnerRow } from "../types.js";

const MODEL = "claude-haiku-4-5";

const SYSTEM_INSTRUCTION =
  "És uma assistente de operações em pt-PT que escreve follow-ups breves para parceiros e influencers de um estúdio de pilates. " +
  'Tom: informal, directo, "tu", sem linguagem de marketing nem jargão. ' +
  "Devolve APENAS o texto da mensagem (2 a 4 frases), sem aspas, sem preâmbulo, sem assinatura.";

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    log.warn("draft_followup.no_api_key");
    return null;
  }
  client = new Anthropic({ apiKey: key });
  return client;
}

function fallback(name: string, daysSince: number): string {
  return `queres seguir-up com ${name}? já passaram ${daysSince} dias do último contacto.`;
}

function buildUserPrompt(
  kind: "partner" | "influencer",
  row: PartnerRow | InfluencerRow,
  daysSince: number,
): string {
  const tipo = kind === "partner" ? "parceiro" : "influencer";
  const ultimoTopico =
    row.proximoPasso && row.proximoPasso.trim().length > 0
      ? row.proximoPasso.trim()
      : row.notas && row.notas.trim().length > 0
        ? row.notas.trim()
        : "(sem próximo passo registado)";

  return [
    `Escreve um follow-up para ${row.nome} (${tipo}).`,
    `Último tópico / próximo passo: ${ultimoTopico}.`,
    `O último contacto foi há ${daysSince} dias.`,
    "2 a 4 frases, informal, directo, sem linguagem de marketing.",
    "Devolve apenas o texto da mensagem.",
  ].join("\n");
}

export async function draftFollowup(
  kind: "partner" | "influencer",
  row: PartnerRow | InfluencerRow,
  daysSince: number,
): Promise<string> {
  const c = getClient();
  if (!c) return fallback(row.nome, daysSince);

  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: [
        {
          type: "text",
          text: SYSTEM_INSTRUCTION,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserPrompt(kind, row, daysSince),
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (text.length === 0) {
      log.warn("draft_followup.empty_response", { id: row.id });
      return fallback(row.nome, daysSince);
    }
    return text;
  } catch (err) {
    log.warn("draft_followup.failed", {
      id: row.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return fallback(row.nome, daysSince);
  }
}
