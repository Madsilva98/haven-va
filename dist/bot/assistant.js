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
import { InlineKeyboard } from "grammy";
import { log } from "../lib/log.js";
import { currentWeekLabel } from "../lib/week.js";
import * as notion from "../notion.js";
import { taskUndoKeyboard } from "./keyboards.js";
import { checkAndUnblockDependents } from "./dependencies.js";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;
const OWNERS = ["Madalena", "Mafalda", "Beatriz", "Unassigned"];
const FOUNDERS = ["Madalena", "Mafalda", "Beatriz"];
const AREAS = [
    "Marketing", "Operações", "Parcerias", "Influencers",
    "Tech", "Cliente", "Financeiro", "Outro",
];
const PRIORITIES = ["Alta", "Média", "Baixa"];
const TO_DISCUSS_URGENCIES = [
    "Próxima reunião", "Decisão offline", "Urgente",
];
const ENTITY_KINDS = ["projeto", "evento", "parceria", "influencer"];
const TOOLS = [
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
                deadline: { type: "string", description: "Data limite YYYY-MM-DD (opcional)" },
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
                    description: "Data/hora em Europe/Lisbon, YYYY-MM-DDTHH:mm (sem timezone). " +
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
        name: "set_focus",
        description: "Define o foco operacional da founder para a semana atual",
        input_schema: {
            type: "object",
            properties: {
                foco: { type: "string", description: "Descrição do foco semanal, pt-PT, <200 chars" },
                founder: {
                    type: "string",
                    enum: ["Madalena", "Mafalda", "Beatriz"],
                    description: "Founder em questão (default: sender)",
                },
            },
            required: ["foco"],
        },
    },
    {
        name: "log_entry",
        description: "Regista um acontecimento no Studio Log (eventos, reuniões, gravações, publicações — o que aconteceu, não decisões)",
        input_schema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Descrição do acontecimento, pt-PT, <150 chars" },
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Tags relevantes, máx 3. Ex: gravação, reunião, parceria, publicação, aula, evento",
                },
            },
            required: ["text"],
        },
    },
    {
        name: "add_to_list",
        description: "Adiciona um item a uma lista no Notion",
        input_schema: {
            type: "object",
            properties: {
                item: { type: "string", description: "Texto do item" },
                lista: { type: "string", description: "Nome da lista (cria automaticamente se não existir)" },
            },
            required: ["item", "lista"],
        },
    },
    {
        name: "check_list_item",
        description: "Marca um item de uma lista como feito",
        input_schema: {
            type: "object",
            properties: {
                item: { type: "string", description: "Título ou parte do título do item" },
                lista: { type: "string", description: "Nome da lista" },
            },
            required: ["item", "lista"],
        },
    },
    {
        name: "update_task",
        description: "Atualiza um campo de uma task existente no backlog",
        input_schema: {
            type: "object",
            properties: {
                task_title: {
                    type: "string",
                    description: "Título ou parte do título da task a editar",
                },
                field: {
                    type: "string",
                    enum: ["status", "owner", "deadline", "prioridade", "area"],
                },
                new_value: {
                    type: "string",
                    description: "Novo valor. status: 'A fazer'|'Em curso'|'Bloqueado'|'Feito'|'Cancelado'. " +
                        "owner: Madalena|Mafalda|Beatriz|Unassigned. " +
                        "prioridade: Alta|Média|Baixa. deadline: YYYY-MM-DD.",
                },
            },
            required: ["task_title", "field", "new_value"],
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
let anthropicClient = null;
let systemPromptText = null;
let modelId = null;
function initRuntime() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error("ANTHROPIC_API_KEY is not set");
        anthropicClient = new Anthropic({ apiKey });
    }
    if (!systemPromptText) {
        systemPromptText = readFileSync(new URL("../prompts/assistant.md", import.meta.url), "utf8");
    }
    if (!modelId) {
        modelId = process.env.ASSISTANT_MODEL ?? DEFAULT_MODEL;
    }
    return { client: anthropicClient, systemPrompt: systemPromptText, model: modelId };
}
function lisbonLocalToUtc(lisbonNaive) {
    // Treat input as Lisbon wall-clock time (no timezone suffix).
    // Parse as UTC, then subtract the Lisbon offset to get the true UTC time.
    const asUtc = new Date(lisbonNaive.includes("Z") || /[+-]\d{2}:/.test(lisbonNaive)
        ? lisbonNaive
        : lisbonNaive + "Z");
    if (Number.isNaN(asUtc.getTime()))
        return lisbonNaive;
    // Compute offset: how many ms ahead Lisbon is relative to UTC at this point
    const lisbonStr = asUtc.toLocaleString("en-US", { timeZone: "Europe/Lisbon" });
    const lisbonParsed = new Date(lisbonStr);
    const offsetMs = lisbonParsed.getTime() - asUtc.getTime();
    const utc = new Date(asUtc.getTime() - offsetMs);
    const p = (n) => String(n).padStart(2, "0");
    return (`${utc.getUTCFullYear()}-${p(utc.getUTCMonth() + 1)}-${p(utc.getUTCDate())}` +
        `T${p(utc.getUTCHours())}:${p(utc.getUTCMinutes())}:${p(utc.getUTCSeconds())}`);
}
function wordOverlap(a, b) {
    const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (wa.size === 0 || wb.size === 0)
        return 0;
    let overlap = 0;
    for (const w of wa)
        if (wb.has(w))
            overlap++;
    return overlap / Math.max(wa.size, wb.size);
}
function buildUserMessage(sender, text, openTasks, recentMessages, repliedToText, contentCalendar) {
    const lines = [];
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
            lines.push(`  - [${t.area}] "${t.title}" — ${t.owner}, ${t.priority ?? "—"}${dead}`);
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
    if (contentCalendar && contentCalendar.length > 0) {
        lines.push("Social Media Calendar:");
        for (const row of contentCalendar) {
            const date = row.publishDate ?? "sem data";
            const adType = row.platform ? ` [${row.platform}]` : "";
            lines.push(`  - "${row.title}" | ${row.status ?? "—"} | ${date}${adType}`);
        }
        lines.push("");
    }
    lines.push(`${sender}: ${text}`);
    return lines.join("\n");
}
async function execCreateTask(input, sender, ctx, openTasks) {
    const title = (typeof input.title === "string" ? input.title.trim() : "").slice(0, 80);
    if (!title)
        return;
    const owner = OWNERS.includes(input.owner)
        ? input.owner
        : "Unassigned";
    const area = AREAS.includes(input.area) ? input.area : "Outro";
    const priority = PRIORITIES.includes(input.priority)
        ? input.priority
        : "Média";
    const why = typeof input.why === "string" ? input.why : "";
    const deadline = typeof input.deadline === "string" && input.deadline ? input.deadline : undefined;
    let entityRef;
    const rawRef = input.entity_ref;
    if (rawRef && typeof rawRef === "object" && !Array.isArray(rawRef)) {
        const ref = rawRef;
        const kind = ref.kind;
        const nome = typeof ref.nome === "string" ? ref.nome.trim() : "";
        if (ENTITY_KINDS.includes(kind) && nome) {
            entityRef = { kind, nome };
        }
    }
    const duplicate = openTasks.find((t) => wordOverlap(title, t.title) >= 0.5);
    const pageId = await notion.createTask({ title, owner, area, why }, priority, ctx.message?.text ?? "", sender, entityRef, deadline);
    let replyText = `✅ task criada: "${title}"`;
    if (duplicate)
        replyText += `\nℹ️ parecida com task existente: "${duplicate.title}"`;
    await ctx.reply(replyText, {
        reply_markup: taskUndoKeyboard(pageId),
    });
}
async function execCreateReminder(input, sender, ctx) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const whenRaw = typeof input.when_iso === "string" ? input.when_iso : "";
    const forWho = typeof input.for === "string" ? input.for : sender;
    if (!text || !whenRaw)
        return;
    const quando = lisbonLocalToUtc(whenRaw);
    const targets = forWho === "all"
        ? [...FOUNDERS]
        : FOUNDERS.includes(forWho)
            ? [forWho]
            : [sender];
    await Promise.all(targets.map((paraQuem) => notion.createReminder({
        texto: text,
        paraQuem,
        quando,
        origem: ctx.message?.text ?? "",
    })));
    const label = forWho === "all" ? "todas" : forWho;
    await ctx.reply(`⏰ lembrete criado para ${label}: "${text}"`);
}
async function execLogDecision(input, sender, ctx) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text)
        return;
    const area = AREAS.includes(input.area) ? input.area : "Outro";
    const notes = typeof input.notes === "string" ? input.notes : "";
    await notion.createDecision({
        decisao: text,
        area,
        tomadaPor: [sender],
        data: null,
        estado: "Pendente implementação",
        notas: notes,
    }, ctx.message?.text ?? "");
    await ctx.reply(`📋 decisão registada: "${text}"`);
}
async function execAddToDiscuss(input, sender, ctx) {
    const tema = typeof input.tema === "string" ? input.tema.trim() : "";
    if (!tema)
        return;
    const urgencia = TO_DISCUSS_URGENCIES.includes(input.urgencia)
        ? input.urgencia
        : "Próxima reunião";
    const area = AREAS.includes(input.area) ? input.area : "Outro";
    const deadline = typeof input.deadline === "string" && input.deadline ? input.deadline : undefined;
    await notion.createToDiscuss({
        tema,
        adicionadoPor: sender,
        urgencia,
        area,
        resolucao: "",
        deadline,
    }, ctx.message?.text ?? "");
    await ctx.reply(`💬 adicionado à lista de discussão: "${tema}"`);
}
async function execSetFocus(input, sender, ctx) {
    const foco = typeof input.foco === "string" ? input.foco.trim().slice(0, 200) : "";
    if (!foco)
        return;
    const founder = FOUNDERS.includes(input.founder)
        ? input.founder
        : sender;
    await notion.setFounderFocus({ founder, semana: currentWeekLabel(), focoOperacional: foco });
    await ctx.reply(`🎯 foco de ${founder} esta semana: "${foco}"`);
}
async function execLogEntry(input, sender, ctx) {
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 150) : "";
    if (!text)
        return;
    const tags = Array.isArray(input.tags)
        ? input.tags.filter((t) => typeof t === "string").map((t) => t.trim()).slice(0, 3)
        : [];
    await notion.createLogEntry({ text, author: sender, tags, originalMessage: ctx.message?.text ?? "" });
    await ctx.reply(`📓 registado: "${text}"`);
}
async function execAddToList(input, sender, ctx) {
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const lista = typeof input.lista === "string" ? input.lista.trim() : "";
    if (!item || !lista)
        return;
    await notion.addToList(item, lista, sender, ctx.message?.text ?? "");
    await ctx.reply(`📝 "${item}" adicionado à lista *${lista}*`);
}
async function execCheckListItem(input, ctx) {
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const lista = typeof input.lista === "string" ? input.lista.trim() : "";
    if (!item || !lista)
        return;
    const pageId = await notion.checkListItem(item, lista);
    if (!pageId) {
        await ctx.reply(`não encontrei "${item}" na lista *${lista}*`);
        return;
    }
    await ctx.reply(`✅ "${item}" marcado como feito`);
}
async function execUpdateTask(input, openTasks, ctx) {
    const taskTitle = typeof input.task_title === "string" ? input.task_title.trim() : "";
    const field = input.field;
    const newValue = typeof input.new_value === "string" ? input.new_value.trim() : "";
    if (!taskTitle || !field || !newValue)
        return;
    if (!["status", "owner", "deadline", "prioridade", "area"].includes(field))
        return;
    // Best fuzzy match — try word overlap first, then substring
    let best = null;
    let bestScore = 0;
    for (const t of openTasks) {
        const score = wordOverlap(taskTitle, t.title);
        if (score > bestScore) {
            bestScore = score;
            best = t;
        }
    }
    if (!best || bestScore === 0) {
        const q = taskTitle.toLowerCase();
        best = openTasks.find((t) => t.title.toLowerCase().includes(q) || q.includes(t.title.toLowerCase())) ?? null;
    }
    if (!best) {
        await ctx.reply(`não encontrei nenhuma task com "${taskTitle}"`);
        return;
    }
    // Capture old value for undo (encode null as "none")
    const oldValue = (() => {
        switch (field) {
            case "status": return best.status;
            case "owner": return best.owner;
            case "deadline": return best.deadline ?? "none";
            case "prioridade": return best.priority ?? "none";
            case "area": return best.area;
        }
    })();
    await notion.updateTask(best.id, field, newValue);
    if (field === "status" && newValue === "Feito") {
        await checkAndUnblockDependents(best.id, best.title);
    }
    const replyText = `✅ "${best.title}" — ${field} → ${newValue}`;
    if (oldValue === "none") {
        await ctx.reply(replyText);
    }
    else {
        const undoData = `task:edit_undo:${best.id}:${field}:${oldValue}`;
        const kb = new InlineKeyboard().text("↩ Desfazer", undoData);
        await ctx.reply(replyText, { reply_markup: kb });
    }
}
async function execCreateEntity(input, sender, ctx) {
    const kind = ENTITY_KINDS.includes(input.kind)
        ? input.kind
        : null;
    if (!kind)
        return;
    const nome = typeof input.nome === "string" ? input.nome.trim() : "";
    if (!nome)
        return;
    const owner = OWNERS.includes(input.owner)
        ? input.owner
        : "Unassigned";
    const kindLabel = {
        projeto: "projeto",
        evento: "evento",
        parceria: "parceiro",
        influencer: "influencer",
    };
    switch (kind) {
        case "projeto":
            await notion.createProject(nome, owner, ctx.message?.text ?? "");
            break;
        case "evento":
            await notion.createEvent(nome, owner, ctx.message?.text ?? "");
            break;
        case "parceria":
            await notion.createPartner(nome, owner, ctx.message?.text ?? "");
            break;
        case "influencer":
            await notion.createInfluencer(nome, owner);
            break;
    }
    log.info("assistant.entity_created", { kind, nome, owner, sender: sender });
    await ctx.reply(`✅ ${kindLabel[kind]} criado: "${nome}"`);
}
export async function handleAssistant(ctx, sender, text, openTasks, recentMessages, repliedToText, contentCalendar) {
    let runtime;
    try {
        runtime = initRuntime();
    }
    catch (err) {
        log.error("assistant.init_failed", { err: String(err) });
        return;
    }
    const systemBlocks = [
        {
            type: "text",
            text: runtime.systemPrompt,
            cache_control: { type: "ephemeral" },
        },
    ];
    let response;
    try {
        response = await runtime.client.messages.create({
            model: runtime.model,
            max_tokens: MAX_TOKENS,
            system: systemBlocks,
            tools: TOOLS,
            messages: [
                {
                    role: "user",
                    content: buildUserMessage(sender, text, openTasks, recentMessages, repliedToText, contentCalendar),
                },
            ],
        });
    }
    catch (err) {
        log.error("assistant.api_error", { err: String(err) });
        return;
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (textBlock?.type === "text" && textBlock.text.trim()) {
        try {
            await ctx.reply(textBlock.text.trim());
        }
        catch (err) {
            log.warn("assistant.reply_failed", { err: String(err) });
        }
    }
    const toolCalls = response.content.filter((b) => b.type === "tool_use");
    for (const block of toolCalls) {
        if (block.type !== "tool_use")
            continue;
        const input = block.input;
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
                case "set_focus":
                    await execSetFocus(input, sender, ctx);
                    break;
                case "log_entry":
                    await execLogEntry(input, sender, ctx);
                    break;
                case "add_to_list":
                    await execAddToList(input, sender, ctx);
                    break;
                case "check_list_item":
                    await execCheckListItem(input, ctx);
                    break;
                case "update_task":
                    await execUpdateTask(input, openTasks, ctx);
                    break;
                case "create_entity":
                    await execCreateEntity(input, sender, ctx);
                    break;
                default:
                    log.warn("assistant.unknown_tool", { name: block.name });
            }
        }
        catch (err) {
            log.error("assistant.tool_failed", { tool: block.name, err: String(err) });
            try {
                await ctx.reply(`erro a executar ação — tenta outra vez`);
            }
            catch {
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
