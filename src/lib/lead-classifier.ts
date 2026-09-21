/**
 * Single Claude Haiku call classifying whether an inbound message is a
 * genuine "I want to know more" lead. Two prompt variants share the same
 * client/error-handling: "email" for src/crons/leads-email-scan.ts,
 * "dm" for src/crons/leads-instagram-scan.ts's DM transcripts. Same
 * singleton-init pattern as src/bot/assistant.ts's initRuntime().
 */

import { readFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";

import { log } from "./log.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const PROMPT_FILES = {
  email: "../prompts/lead-classifier.md",
  dm: "../prompts/lead-classifier-dm.md",
} as const;
type PromptKey = keyof typeof PROMPT_FILES;

let anthropicClient: Anthropic | null = null;
const promptCache = new Map<PromptKey, string>();

function initRuntime(promptKey: PromptKey): { client: Anthropic; prompt: string; model: string } {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    anthropicClient = new Anthropic({ apiKey });
  }
  let prompt = promptCache.get(promptKey);
  if (!prompt) {
    prompt = readFileSync(new URL(PROMPT_FILES[promptKey], import.meta.url), "utf8");
    promptCache.set(promptKey, prompt);
  }
  const model = process.env.LEAD_CLASSIFIER_MODEL ?? DEFAULT_MODEL;
  return { client: anthropicClient, prompt, model };
}

/**
 * Returns the model's raw trimmed/uppercased one-word answer, or "" on any
 * API error — callers decide their own safe default from that, but every
 * prompt variant here is written to bias toward the cheapest-to-miss
 * outcome (NÃO/NENHUM) when uncertain, so "" behaves the same way a
 * genuine NÃO/NENHUM answer would in every caller below.
 */
async function callClassifier(text: string, promptKey: PromptKey): Promise<string> {
  const { client, prompt, model } = initRuntime(promptKey);
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 20,
      system: prompt,
      messages: [{ role: "user", content: text.slice(0, 8000) }],
    });
    const block = response.content.find((b) => b.type === "text");
    return block && block.type === "text" ? block.text.trim().toUpperCase() : "";
  } catch (err) {
    log.warn("lead_classifier.request_failed", {
      promptKey,
      message: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

/** `text` should be the email's subject + body (plain text). */
export async function isGenuineInformationRequest(text: string): Promise<boolean> {
  const answer = await callClassifier(text, "email");
  return answer.startsWith("SIM");
}

export type InstagramDMClassification = "cliente" | "parceiro" | "nenhum";

/**
 * `text` should be a chronological Cliente/Haven Instagram DM transcript.
 * "cliente" = genuine information request from a prospective client;
 * "parceiro" = another business/professional reaching out for networking,
 * not asking to become a client; "nenhum" = neither (also the fallback for
 * an API error or an unrecognized answer).
 */
export async function classifyInstagramDM(text: string): Promise<InstagramDMClassification> {
  const answer = await callClassifier(text, "dm");
  if (answer.startsWith("CLIENTE")) return "cliente";
  if (answer.startsWith("PARCEIRO")) return "parceiro";
  return "nenhum";
}
