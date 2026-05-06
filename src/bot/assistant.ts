/**
 * Conversational assistant — replaces the multi-intent extraction pipeline.
 *
 * Single Haiku call with tool use (auto choice). Tools cover the four most
 * common Notion actions. The model responds in text for queries, calls tools
 * for actions, or stays silent for banter.
 *
 * System prompt: src/prompts/assistant.md, ephemeral-cached.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import type { Context } from "grammy";

import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import { taskUndoKeyboard } from "./keyboards.js";
import type {
  Area,
  EntityKind,
  EntityRef,
  FounderName,
  OpenTask,
  OwnerValue,
  Priority,
  ToDiscussUrgency,
} from "../types.js";

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;

const OWNERS: OwnerValue[] = ["Madalena", "Mafalda", "Beatriz", "Unassigned"];
const FOUNDERS: FounderName[] = ["Madalena", "Mafalda", "Beatriz"];
const AREAS: Area[] = [
  "Marketing", "Operações", "Parcerias", "Influencers",
  "Tech", "Cliente", "Financeiro", "Outro",
];
const PRIORITIES: Priority[] = ["Alta", "Média", "Baixa"];
const TO_DISCUSS_URGENCIES: ToDiscussUrgency[] = [
  "Próxima reunião", "Decisão offline", "Urgente",
];
const ENTITY_KINDS: EntityKind[] = ["projeto", "evento", "parceria", "influencer"];

const TOOLS: Anthropic.Tool[] = [
  {
    name: "create_task",
    description: "Cria uma task no Notion backlog",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Título imperativo, pt-PT, <80 chars" },
        owner: { type: "string", enum: OWNERS },
        area: { type: "string", enum: AREAS },
        priority: { type: "string", enum: PRIORITIES },
        why: { type: "string", description: "Razão de negócio, <120 chars" },
        entity_ref: {
          type: "object",
          description: "Associar a task a uma entidade existente (parceiro, projeto, etc.)",
          properties: {
            kind: { type: "string", enum: ENTITY_KINDS },
            nome: { type: "string" },
          },
          required: ["kind", "nome"],
        },
      },
      required: ["title", "owner", "area"],
    },
  },
  {
    name: "create_reminder",
    description: "Cria um lembrete no Notion para uma ou mais founders",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Texto do lembrete" },
        when_iso: {
          type: "string",
          description:
            "Data/hora em Europe/Lisbon, YYYY-MM-DDTHH:mm (sem timezone). " +
            "Default time = 09:00 se não especificado.",
        },
        for: {
          type: "string",
          enum: ["Madalena", "Mafalda", "Beatriz", "all"],
        },
      },
      required: ["text", "when_iso", "for"],
    },
  },
  {
    name: "log_decision",
    description: "Regista uma decisão no Notion",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "A decisão em pt-PT" },
        area: { type: "string", enum: AREAS },
        notes: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "add_to_discuss",
    description: "Adiciona um tópico à lista de discussão",
    input_schema: {
      type: "object",
      properties: {
        tema: { type: "string", description: "Tópico, <120 chars" },
        urgencia: { type: "string", enum: TO_DISCUSS_URGENCIES },
        area: { type: "string", enum: AREAS },
        deadline: { type: "string", description: "Data limite, YYYY-MM-DD (opcional)" },
      },
      required: ["tema"],
    },
  },
  {
    name: "create_entity",
    description: "Cria um parceiro, projeto, evento ou influencer no Notion",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ENTITY_KINDS },
        nome: { type: "string", description: "Nome da entidade" },
        owner: { type: "string", enum: OWNERS },
      },
      required: ["kind", "nome"],
    },
  },
];

let anthropicClient: Anthropic | null = null;
let systemPromptText: string | null = null;
let modelId: string | null = null;

function initRuntime(): { client: Anthropic; systemPrompt: string; model: string } {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    anthropicClient = new Anthropic({ apiKey });
  }
  if (!systemPromptText) {
    systemPromptText = readFileSync(
      new URL("../prompts/assistant.md", import.meta.url),
      "utf8",
    );
  }
  if (!modelId) {
    modelId = process.env.ASSISTANT_MODEL ?? DEFAULT_MODEL;
  }
  return { client: anthropicClient, systemPrompt: systemPromptText, model: modelId };
}

function lisbonLocalToUtc(lisbonNaive: string): string {
  // Treat input as Lisbon wall-clock time (no timezone suffix).
  // Parse as UTC, then subtract the Lisbon offset to get the true UTC time.
  const asUtc = new Date(lisbonNaive.includes("Z") || /[+-]\d{2}:/.test(lisbonNaive)
    ? lisbonNaive
    : lisbonNaive + "Z",
  );
  if (Number.isNaN(asUtc.getTime())) return lisbonNaive;

  // Compute offset: how many ms ahead Lisbon is relative to UTC at this point
  const lisbonStr = asUtc.toLocaleString("en-US", { timeZone: "Europe/Lisbon" });
  const lisbonParsed = new Date(lisbonStr);
  const offsetMs = lisbonParsed.getTime() - asUtc.getTime();

  const utc = new Date(asUtc.getTime() - offsetMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${utc.getUTCFullYear()}-${p(utc.getUTCMonth() + 1)}-${p(utc.getUTCDate())}` +
    `T${p(utc.getUTCHours())}:${p(utc.getUTCMinutes())}:${p(utc.getUTCSeconds())}`
  );
}

function wordOverlap(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let overlap = 0;
  for (const w of wa) if (wb.has(w)) overlap++;
  return overlap / Math.max(wa.size, wb.size);
}

function buildUserMessage(
  sender: FounderName,
  text: string,
  openTasks: OpenTask[],
  recentMessages: { sender: FounderName; text: string }[],
  repliedToText?: string,
): string {
  const lines: string[] = [];

  const now = new Date();
  const today = now.toLocaleDateString("pt-PT", {
    timeZone: "Europe/Lisbon",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = now.toLocaleTimeString("pt-PT", {
    timeZone: "Europe/Lisbon",
    hour: "2-digit",
    minute: "2-digit",
  });
  lines.push(`Hoje: ${today}, ${time} (Europe/Lisbon)`);
  lines.push("");

  if (openTasks.length > 0) {
    lines.push("Tasks em aberto:");
    for (const t of openTasks.slice(0, 20)) {
      const dead = t.deadline ? ` | prazo=${t.deadline}` : "";
      lines.push(
        `  - [${t.area}] "${t.title}" — ${t.owner}, ${t.priority ?? "—"}${dead}`,
      );
    }
    lines.push("");
  }

  if (recentMessages.length > 0) {
    lines.push("Conversa recente:");
    for (const m of recentMessages) {
      lines.push(`${m.sender}: ${m.text}`);
    }
    lines.push("");
  }

  if (repliedToText) {
    lines.push(`[Em resposta ao bot: "${repliedToText}"]`);
    lines.push("");
  }

  lines.push(`${sender}: ${text}`);
  return lines.join("\n");
}

async function execCreateTask(
  input: Record<string, unknown>,
  sender: FounderName,
  ctx: Context,
  openTasks: OpenTask[],
): Promise<void> {
  const title = (typeof input.title === "string" ? input.title.trim() : "").slice(0, 80);
  if (!title) return;
  const owner = OWNERS.includes(input.owner as OwnerValue)
    ? (input.owner as OwnerValue)
    : "Unassigned";
  const area = AREAS.includes(input.area as Area) ? (input.area as Area) : "Outro";
  const priority = PRIORITIES.includes(input.priority as Priority)
    ? (input.priority as Priority)
    : "Média";
  const why = typeof input.why === "string" ? input.why : "";

  let entityRef: EntityRef | undefined;
  const rawRef = input.entity_ref;
  if (rawRef && typeof rawRef === "object" && !Array.isArray(rawRef)) {
    const ref = rawRef as Record<string, unknown>;
    const kind = ref.kind as EntityKind;
    const nome = typeof ref.nome === "string" ? ref.nome.trim() : "";
    if (ENTITY_KINDS.includes(kind) && nome) {
      entityRef = { kind, nome };
    }
  }

  const duplicate = openTasks.find((t) => wordOverlap(title, t.title) >= 0.5);

  const pageId = await notion.createTask(
    { title, owner, area, why },
    priority,
    ctx.message?.text ?? "",
    sender,
    entityRef,
  );

  let replyText = `✅ task criada: "${title}"`;
  if (duplicate) replyText += `\nℹ️ parecida com task existente: "${duplicate.title}"`;

  await ctx.reply(replyText, {
    reply_markup: taskUndoKeyboard(pageId),
  });
}

async function execCreateReminder(
  input: Record<string, unknown>,
  sender: FounderName,
  ctx: Context,
): Promise<void> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const whenRaw = typeof input.when_iso === "string" ? input.when_iso : "";
  const forWho = typeof input.for === "string" ? input.for : sender;
  if (!text || !whenRaw) return;

  const quando = lisbonLocalToUtc(whenRaw);
  const targets: FounderName[] =
    forWho === "all"
      ? [...FOUNDERS]
      : FOUNDERS.includes(forWho as FounderName)
        ? [forWho as FounderName]
        : [sender];

  await Promise.all(
    targets.map((paraQuem) =>
      notion.createReminder({
        texto: text,
        paraQuem,
        quando,
        origem: ctx.message?.text ?? "",
      }),
    ),
  );

  const label = forWho === "all" ? "todas" : forWho;
  await ctx.reply(`⏰ lembrete criado para ${label}: "${text}"`);
}

async function execLogDecision(
  input: Record<string, unknown>,
  sender: FounderName,
  ctx: Context,
): Promise<void> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) return;
  const area = AREAS.includes(input.area as Area) ? (input.area as Area) : "Outro";
  const notes = typeof input.notes === "string" ? input.notes : "";
  const today = new Date().toISOString().split("T")[0]!;

  await notion.createDecision({
    decisao: text,
    area,
    tomadaPor: [sender],
    data: today,
    estado: "Pendente implementação",
    notas: notes,
  });
  await ctx.reply(`📋 decisão registada: "${text}"`);
}

async function execAddToDiscuss(
  input: Record<string, unknown>,
  sender: FounderName,
  ctx: Context,
): Promise<void> {
  const tema = typeof input.tema === "string" ? input.tema.trim() : "";
  if (!tema) return;
  const urgencia = TO_DISCUSS_URGENCIES.includes(input.urgencia as ToDiscussUrgency)
    ? (input.urgencia as ToDiscussUrgency)
    : "Próxima reunião";
  const area = AREAS.includes(input.area as Area) ? (input.area as Area) : "Outro";
  const deadline = typeof input.deadline === "string" && input.deadline ? input.deadline : undefined;

  await notion.createToDiscuss({
    tema,
    adicionadoPor: sender,
    urgencia,
    area,
    resolucao: "",
    deadline,
  });
  await ctx.reply(`💬 adicionado à lista de discussão: "${tema}"`);
}

async function execCreateEntity(
  input: Record<string, unknown>,
  sender: FounderName,
  ctx: Context,
): Promise<void> {
  const kind = ENTITY_KINDS.includes(input.kind as EntityKind)
    ? (input.kind as EntityKind)
    : null;
  if (!kind) return;
  const nome = typeof input.nome === "string" ? input.nome.trim() : "";
  if (!nome) return;
  const owner = OWNERS.includes(input.owner as OwnerValue)
    ? (input.owner as OwnerValue)
    : "Unassigned";

  const kindLabel: Record<EntityKind, string> = {
    projeto: "projeto",
    evento: "evento",
    parceria: "parceiro",
    influencer: "influencer",
  };

  switch (kind) {
    case "projeto":
      await notion.createProject(nome, owner);
      break;
    case "evento":
      await notion.createEvent(nome, owner);
      break;
    case "parceria":
      await notion.createPartner(nome, owner);
      break;
    case "influencer":
      await notion.createInfluencer(nome, owner);
      break;
  }

  log.info("assistant.entity_created", { kind, nome, owner, sender: sender });
  await ctx.reply(`✅ ${kindLabel[kind]} criado: "${nome}"`);
}

export async function handleAssistant(
  ctx: Context,
  sender: FounderName,
  text: string,
  openTasks: OpenTask[],
  recentMessages: { sender: FounderName; text: string }[],
  repliedToText?: string,
): Promise<void> {
  let runtime: ReturnType<typeof initRuntime>;
  try {
    runtime = initRuntime();
  } catch (err) {
    log.error("assistant.init_failed", { err: String(err) });
    return;
  }

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: runtime.systemPrompt,
      cache_control: { type: "ephemeral" },
    },
  ];

  let response: Anthropic.Message;
  try {
    response = await runtime.client.messages.create({
      model: runtime.model,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: buildUserMessage(sender, text, openTasks, recentMessages, repliedToText),
        },
      ],
    });
  } catch (err) {
    log.error("assistant.api_error", { err: String(err) });
    return;
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (textBlock?.type === "text" && textBlock.text.trim()) {
    try {
      await ctx.reply(textBlock.text.trim());
    } catch (err) {
      log.warn("assistant.reply_failed", { err: String(err) });
    }
  }

  const toolCalls = response.content.filter((b) => b.type === "tool_use");
  for (const block of toolCalls) {
    if (block.type !== "tool_use") continue;
    const input = block.input as Record<string, unknown>;
    try {
      switch (block.name) {
        case "create_task":
          await execCreateTask(input, sender, ctx, openTasks);
          break;
        case "create_reminder":
          await execCreateReminder(input, sender, ctx);
          break;
        case "log_decision":
          await execLogDecision(input, sender, ctx);
          break;
        case "add_to_discuss":
          await execAddToDiscuss(input, sender, ctx);
          break;
        case "create_entity":
          await execCreateEntity(input, sender, ctx);
          break;
        default:
          log.warn("assistant.unknown_tool", { name: block.name });
      }
    } catch (err) {
      log.error("assistant.tool_failed", { tool: block.name, err: String(err) });
      try {
        await ctx.reply(`erro a executar ação — tenta outra vez`);
      } catch {
        // ignore
      }
    }
  }

  log.info("assistant.handled", {
    sender,
    tools: toolCalls.map((b) => (b.type === "tool_use" ? b.name : "")),
    hasText: Boolean(textBlock?.type === "text" && textBlock.text.trim()),
  });
}
