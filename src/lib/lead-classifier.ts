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
 * Defaults to false (don't classify as a lead) on any API error — a missed
 * lead is far cheaper than a crashed cron.
 */
async function classify(text: string, promptKey: PromptKey): Promise<boolean> {
  const { client, prompt, model } = initRuntime(promptKey);
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 20,
      system: prompt,
      messages: [{ role: "user", content: text.slice(0, 8000) }],
    });
    const block = response.content.find((b) => b.type === "text");
    const answer = block && block.type === "text" ? block.text.trim().toUpperCase() : "";
    return answer.startsWith("SIM");
  } catch (err) {
    log.warn("lead_classifier.request_failed", {
      promptKey,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** `text` should be the email's subject + body (plain text). */
export async function isGenuineInformationRequest(text: string): Promise<boolean> {
  return classify(text, "email");
}

/** `text` should be a chronological Cliente/Haven Instagram DM transcript. */
export async function isGenuineInformationRequestDM(text: string): Promise<boolean> {
  return classify(text, "dm");
}
