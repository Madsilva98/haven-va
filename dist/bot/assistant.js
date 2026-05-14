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
import { log } from "../lib/log.js";
import { currentWeekLabel } from "../lib/week.js";
import * as calendar from "../lib/calendar.js";
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
                priority: { type: "string", enum: PRIORITIES, description: "Default: Média" },
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
                task_page_id: {
                    type: "string",
                    description: "PageId da task associada (do resultado de create_task). " +
                        "Só usar quando o lembrete se refere a uma task criada nesta mesma conversa.",
                },
                recurrence: {
                    type: "string",
                    description: "Repetição automática. Ex: 'diária', 'semanal', 'mensal', 'a cada 2 semanas'. Usa quando a mensagem pedir repetição.",
                },
            },
            required: ["text", "when_iso", "for"],
        },
    },
    {
        name: "cancel_reminder",
        description: "Cancela um lembrete pendente — arquiva-o para que não dispare",
        input_schema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Texto (ou parte) do lembrete a cancelar" },
            },
            required: ["text"],
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
                entity_ref: {
                    type: "object",
                    description: "Ligar o tópico a uma entidade (projeto, evento, parceiro, influencer) se mencionado na mensagem",
                    properties: {
                        kind: { type: "string", enum: ENTITY_KINDS },
                        nome: { type: "string" },
                    },
                    required: ["kind", "nome"],
                },
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
                owner: {
                    type: "string",
                    enum: ["Madalena", "Mafalda", "Beatriz"],
                    description: "Quem fez a ação. Inferir do contexto — pode ser diferente de quem escreveu a mensagem. Ex: 'a Mafalda enviou um email' → owner=Mafalda.",
                },
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
        name: "create_content_calendar_entry",
        description: "Adiciona uma entrada ao Content Calendar (Social Media Calendar). NUNCA usar add_to_list para conteúdo social.",
        input_schema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Título do conteúdo" },
                status: { type: "string", description: "Estado: raw idea, ideation, ready to record, editing, ready to post, posted. Default: raw idea" },
                publish_date: { type: "string", description: "Data de publicação YYYY-MM-DD (opcional)" },
                ad_type: { type: "string", description: "Tipo: Post, Story, Reel, Carrossel, etc. (opcional)" },
            },
            required: ["title"],
        },
    },
    {
        name: "add_to_list",
        description: "Adiciona um item a uma lista genérica no Notion. NÃO usar para Content Calendar ou Social Media Calendar.",
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
        description: "Marca um item de uma lista como feito (item comprado, tarefa concluída, etc.). Usar quando a pessoa diz 'já fiz', 'já comprei', 'feito', 'marcar como feito'.",
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
        name: "delete_list_item",
        description: "Apaga (remove permanentemente) um item de uma lista. Usar quando a pessoa diz 'apaga', 'remove', 'tira', 'já não preciso', 'cancela' — não quando quer marcar como feito.",
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
        name: "update_record",
        description: "Atualiza uma propriedade de qualquer registo em qualquer DB do Notion.",
        input_schema: {
            type: "object",
            properties: {
                db: {
                    type: "string",
                    enum: ["backlog", "to_discuss", "decisions", "content_calendar", "partners", "influencers", "events", "projects"],
                    description: "Base de dados alvo",
                },
                item: {
                    type: "string",
                    description: "Título ou parte do título do registo a editar",
                },
                field: {
                    type: "string",
                    description: "Campo a editar. " +
                        "backlog: status|owner|deadline|prioridade|area|title. " +
                        "to_discuss: urgencia|estado|area|resolucao. " +
                        "decisions: estado|area|notas. " +
                        "content_calendar: status|publish_date|ad_type. " +
                        "partners|influencers: status|owner. " +
                        "events|projects: status|owner.",
                },
                new_value: {
                    type: "string",
                    description: "Novo valor. " +
                        "backlog status: A fazer|Em curso|Bloqueado|Feito|Cancelado. " +
                        "backlog owner: Madalena|Mafalda|Beatriz|Unassigned. " +
                        "backlog prioridade: Alta|Média|Baixa. deadline: YYYY-MM-DD. " +
                        "to_discuss urgencia: Próxima reunião|Decisão offline|Urgente. " +
                        "to_discuss estado: Pendente|Discutido|Arquivado. " +
                        "decisions estado: Pendente implementação|Implementada. " +
                        "content_calendar status: raw idea|ideation|ready to record|editing|ready to post|posted. " +
                        "partners|influencers status: A contactar|Em negociação|Ativo|Inativo. " +
                        "events status: Ideia|Planeado|Confirmado|Realizado|Cancelado. " +
                        "projects status: Ativo|Em pausa|Concluído|Cancelado.",
                },
            },
            required: ["db", "item", "field", "new_value"],
        },
    },
    {
        name: "add_to_page_section",
        description: "Adiciona conteúdo ao corpo de uma página (projeto, evento, parceiro ou influencer). Cria a secção se não existir.",
        input_schema: {
            type: "object",
            properties: {
                db: {
                    type: "string",
                    enum: ["projects", "events", "partners", "influencers"],
                    description: "Base de dados da página",
                },
                page_name: {
                    type: "string",
                    description: "Nome da página (projeto, evento, parceiro ou influencer)",
                },
                content: {
                    type: "string",
                    description: "Conteúdo a adicionar. Linhas com '- ' tornam-se bullets; texto normal torna-se parágrafo.",
                },
                section: {
                    type: "string",
                    description: "Nome da secção (toggle heading). Omitir para escrever na raiz. Se não existir, é criada com 📌.",
                },
            },
            required: ["db", "page_name", "content"],
        },
    },
    {
        name: "search_records",
        description: "Pesquisa registos em qualquer DB do Notion por título. Usa antes de criar (verificar duplicados) ou antes de atualizar (encontrar o registo certo). NÃO envia resposta ao utilizador.",
        input_schema: {
            type: "object",
            properties: {
                db: {
                    type: "string",
                    enum: ["backlog", "to_discuss", "decisions", "content_calendar", "partners", "influencers", "events", "projects"],
                    description: "Base de dados a pesquisar",
                },
                query: {
                    type: "string",
                    description: "Título ou parte do título a pesquisar",
                },
            },
            required: ["db", "query"],
        },
    },
    {
        name: "create_calendar_event",
        description: "Cria um evento no Google Calendar (calendário pessoal). Usar quando a mensagem pede para marcar, agendar ou criar um evento/reunião no calendário.",
        input_schema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Título do evento" },
                start_iso: {
                    type: "string",
                    description: "Início do evento em Europe/Lisbon, YYYY-MM-DDTHH:mm (sem timezone)",
                },
                end_iso: {
                    type: "string",
                    description: "Fim do evento em Europe/Lisbon, YYYY-MM-DDTHH:mm. Se não especificado, 1 hora depois do início.",
                },
                description: { type: "string", description: "Descrição do evento (opcional)" },
                calendar_name: {
                    type: "string",
                    description: "Nome do calendário a usar. Escolhe o nome mais próximo da lista 'Calendários Google disponíveis' no contexto. Se omitido, usa o calendário principal.",
                },
            },
            required: ["title", "start_iso"],
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
const SILENCE_PHRASES = [
    "fico em silêncio",
    "staying silent",
    "não há nada a fazer",
    "é apenas contexto",
    "não é uma ação",
    "não requer ação",
    "não vou responder",
];
function isSilenceResponse(text) {
    const lower = text.toLowerCase();
    return SILENCE_PHRASES.some((p) => lower.includes(p));
}
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
    // ISO datetime without timezone → V8 parses as local time (TZ=Europe/Lisbon).
    // If already timezone-aware (Z or +HH:mm), new Date() handles it correctly.
    // Either way, getUTC* gives the correct UTC components.
    const d = new Date(lisbonNaive);
    if (Number.isNaN(d.getTime()))
        return lisbonNaive;
    const p = (n) => String(n).padStart(2, "0");
    return (`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
        `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`);
}
function buildUserMessage(sender, text, recentMessages, repliedToText, contentCalendar, lastBotReplies, openTasks, availableCalendars, availableLists) {
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
    if (recentMessages.length > 0) {
        lines.push("Conversa recente:");
        for (const m of recentMessages) {
            lines.push(`${m.sender}: ${m.text}`);
        }
        lines.push("");
    }
    if (lastBotReplies && lastBotReplies.length > 0) {
        lines.push(`[Última ação do bot: ${lastBotReplies.map((r) => `"${r}"`).join(" | ")}]`);
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
    if (openTasks && openTasks.length > 0) {
        lines.push(`Tasks de ${sender}:`);
        for (const t of openTasks) {
            const deadline = t.deadline ? ` | até ${t.deadline}` : "";
            lines.push(`  - ${t.title} | ${t.status} | ${t.area}${deadline}`);
        }
        lines.push("");
    }
    if (availableCalendars && availableCalendars.length > 0) {
        lines.push(`Calendários Google disponíveis: ${availableCalendars.map((c) => c.summary).join(", ")}`);
        lines.push("");
    }
    if (availableLists && availableLists.length > 0) {
        lines.push(`Listas disponíveis: ${availableLists.join(", ")}`);
        lines.push("");
    }
    lines.push(`${sender}: ${text}`);
    return lines.join("\n");
}
async function execCreateTask(input, sender, ctx, collector) {
    const title = (typeof input.title === "string" ? input.title.trim() : "").slice(0, 80);
    if (!title)
        return "título em falta";
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
    const pageId = await notion.createTask({ title, owner, area, why }, priority, ctx.message?.text ?? "", sender, entityRef, deadline);
    const replyText = `✅ task criada: "${title}"`;
    collector.push(replyText);
    await ctx.reply(replyText, { reply_markup: taskUndoKeyboard(pageId) });
    return `ok | pageId: ${pageId}`;
}
async function execCreateReminder(input, sender, ctx, collector) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const whenRaw = typeof input.when_iso === "string" ? input.when_iso : "";
    const forWho = typeof input.for === "string" ? input.for : sender;
    if (!text || !whenRaw)
        return "parâmetros em falta";
    const quando = lisbonLocalToUtc(whenRaw);
    const targets = forWho === "all"
        ? [...FOUNDERS]
        : FOUNDERS.includes(forWho)
            ? [forWho]
            : [sender];
    const taskPageId = typeof input.task_page_id === "string" && input.task_page_id
        ? input.task_page_id
        : undefined;
    const recurrence = typeof input.recurrence === "string" ? input.recurrence : undefined;
    await Promise.all(targets.map((paraQuem) => notion.createReminder({
        texto: text,
        paraQuem,
        quando,
        origem: ctx.message?.text ?? "",
        recurrence,
    }, taskPageId)));
    const label = forWho === "all" ? "todas" : forWho;
    const recurrenceLabel = recurrence ? ` (repete: ${recurrence})` : "";
    const reminderReply = `⏰ lembrete criado para ${label}: "${text}"${recurrenceLabel}`;
    collector.push(reminderReply);
    await ctx.reply(reminderReply);
    return "ok";
}
async function execCancelReminder(input, ctx, collector) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text)
        return "texto em falta";
    const title = await notion.cancelReminder(text);
    if (!title) {
        const msg = `não encontrei nenhum lembrete pendente com "${text}"`;
        await ctx.reply(msg);
        return msg;
    }
    const reply = `🗑️ lembrete cancelado: "${title}"`;
    collector.push(reply);
    await ctx.reply(reply);
    return "ok";
}
async function execLogDecision(input, sender, ctx, collector) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text)
        return "parâmetros em falta";
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
    const decisionReply = `📋 decisão registada: "${text}"`;
    collector.push(decisionReply);
    await ctx.reply(decisionReply);
    return "ok";
}
async function execAddToDiscuss(input, sender, ctx, collector) {
    const tema = typeof input.tema === "string" ? input.tema.trim() : "";
    if (!tema)
        return "parâmetros em falta";
    const urgencia = TO_DISCUSS_URGENCIES.includes(input.urgencia)
        ? input.urgencia
        : "Próxima reunião";
    const area = AREAS.includes(input.area) ? input.area : "Outro";
    const deadline = typeof input.deadline === "string" && input.deadline ? input.deadline : undefined;
    let entityRef;
    const rawRef = input.entity_ref;
    if (rawRef && typeof rawRef === "object" && !Array.isArray(rawRef)) {
        const ref = rawRef;
        const kind = ref.kind;
        const nome = typeof ref.nome === "string" ? ref.nome.trim() : "";
        if (ENTITY_KINDS.includes(kind) && nome)
            entityRef = { kind, nome };
    }
    log.info("assistant.add_to_discuss", { tema, entityRef: entityRef ?? null });
    await notion.createToDiscuss({
        tema,
        adicionadoPor: sender,
        urgencia,
        area,
        resolucao: "",
        deadline,
    }, ctx.message?.text ?? "", entityRef);
    const linkedSuffix = entityRef ? ` (ligado a ${entityRef.nome})` : "";
    const discussReply = `💬 adicionado à lista de discussão: "${tema}"${linkedSuffix}`;
    collector.push(discussReply);
    await ctx.reply(discussReply);
    return "ok";
}
async function execSetFocus(input, sender, ctx, collector) {
    const foco = typeof input.foco === "string" ? input.foco.trim().slice(0, 200) : "";
    if (!foco)
        return "parâmetros em falta";
    const founder = FOUNDERS.includes(input.founder)
        ? input.founder
        : sender;
    await notion.setFounderFocus({ founder, semana: currentWeekLabel(), focoOperacional: foco });
    const focusReply = `🎯 foco de ${founder} esta semana: "${foco}"`;
    collector.push(focusReply);
    await ctx.reply(focusReply);
    return "ok";
}
async function execLogEntry(input, sender, ctx, collector) {
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 150) : "";
    if (!text)
        return "parâmetros em falta";
    const owner = FOUNDERS.includes(input.owner) ? input.owner : sender;
    const tags = Array.isArray(input.tags)
        ? input.tags.filter((t) => typeof t === "string").map((t) => t.trim()).slice(0, 3)
        : [];
    await notion.createLogEntry({ text, author: owner, tags, originalMessage: ctx.message?.text ?? "" });
    const logReply = `📓 registado: "${text}"`;
    collector.push(logReply);
    await ctx.reply(logReply);
    return "ok";
}
async function execAddToList(input, sender, ctx, collector) {
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const lista = typeof input.lista === "string" ? input.lista.trim() : "";
    if (!item || !lista)
        return "parâmetros em falta";
    await notion.addToList(item, lista, sender, ctx.message?.text ?? "");
    const listReply = `📝 "${item}" adicionado à lista *${lista}*`;
    collector.push(listReply);
    await ctx.reply(listReply);
    return "ok";
}
async function execCreateContentCalendarEntry(input, sender, ctx, collector) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title)
        return "parâmetros em falta";
    const status = typeof input.status === "string" ? input.status.trim() : "Raw Idea";
    const publishDate = typeof input.publish_date === "string" && input.publish_date ? input.publish_date : undefined;
    const adType = typeof input.ad_type === "string" ? input.ad_type.trim() : undefined;
    await notion.createContentCalendarEntry({
        title,
        status,
        publishDate,
        adType,
        originalMsg: ctx.message?.text ?? "",
    });
    const calReply = `📅 "${title}" adicionado ao Content Calendar`;
    collector.push(calReply);
    await ctx.reply(calReply);
    return "ok";
}
async function execCheckListItem(input, ctx, collector) {
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const lista = typeof input.lista === "string" ? input.lista.trim() : "";
    if (!item || !lista)
        return "parâmetros em falta";
    const pageId = await notion.checkListItem(item, lista);
    if (!pageId) {
        await ctx.reply(`não encontrei "${item}" na lista *${lista}*`);
        return `não encontrado: ${item}`;
    }
    const checkReply = `✅ "${item}" marcado como feito`;
    collector.push(checkReply);
    await ctx.reply(checkReply);
    return "ok";
}
async function execDeleteListItem(input, ctx, collector) {
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const lista = typeof input.lista === "string" ? input.lista.trim() : "";
    if (!item || !lista)
        return "parâmetros em falta";
    const pageId = await notion.deleteListItem(item, lista);
    if (!pageId) {
        await ctx.reply(`não encontrei "${item}" na lista *${lista}*`);
        return `não encontrado: ${item}`;
    }
    const reply = `🗑️ "${item}" removido da lista`;
    collector.push(reply);
    await ctx.reply(reply);
    return "ok";
}
async function execUpdateRecord(input, ctx, collector) {
    const db = typeof input.db === "string" ? input.db.trim() : "";
    const item = typeof input.item === "string" ? input.item.trim() : "";
    const field = typeof input.field === "string" ? input.field.trim() : "";
    const newValue = typeof input.new_value === "string" ? input.new_value.trim() : "";
    if (!db || !item || !field || !newValue)
        return "parâmetros em falta";
    if (db === "backlog") {
        const editableFields = ["status", "owner", "deadline", "prioridade", "area", "title"];
        if (!editableFields.includes(field))
            return `campo desconhecido: ${field}`;
        const editField = field;
        const found = await notion.findBacklogTask(item);
        if (!found) {
            const msg = `não encontrei nenhuma task com "${item}"`;
            await ctx.reply(msg);
            return msg;
        }
        await notion.updateTask(found.id, editField, newValue);
        if (editField === "status" && newValue === "Feito") {
            await checkAndUnblockDependents(found.id, found.title);
        }
        const replyText = `✅ "${found.title}" — ${field} → ${newValue}`;
        collector.push(replyText);
        await ctx.reply(replyText);
        return "ok";
    }
    const result = await notion.updateRecord(db, item, field, newValue);
    if (!result) {
        const msg = `não encontrei "${item}" em ${db}`;
        await ctx.reply(msg);
        return msg;
    }
    const replyText = `✅ "${result.title}" — ${field} → ${newValue}`;
    collector.push(replyText);
    await ctx.reply(replyText);
    return "ok";
}
async function execAddToPageSection(input, ctx, collector) {
    const db = typeof input.db === "string" ? input.db.trim() : "";
    const pageName = typeof input.page_name === "string" ? input.page_name.trim() : "";
    const content = typeof input.content === "string" ? input.content.trim() : "";
    const section = typeof input.section === "string" ? input.section.trim() : undefined;
    if (!db || !pageName || !content)
        return "parâmetros em falta";
    const page = await notion.findPageInDb(db, pageName);
    if (!page) {
        await ctx.reply(`não encontrei "${pageName}" em ${db}`);
        return `não encontrado: ${pageName}`;
    }
    await notion.appendToPageSection(page.id, content, section);
    const where = section ? `secção "${section}"` : "página";
    const reply = `✏️ escrito em "${page.title}" — ${where}`;
    collector.push(reply);
    await ctx.reply(reply);
    return "ok";
}
async function execSearchRecords(input) {
    const db = typeof input.db === "string" ? input.db.trim() : "backlog";
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query)
        return "query vazia";
    const results = await notion.searchRecords(db, query);
    if (results.length === 0)
        return `nenhum resultado para "${query}" em ${db}`;
    return results
        .map((r) => {
        const parts = [`"${r.title}"`];
        if (r.owner)
            parts.push(r.owner);
        if (r.status)
            parts.push(r.status);
        if (r.area)
            parts.push(r.area);
        if (r.priority)
            parts.push(r.priority);
        if (r.deadline)
            parts.push(`prazo: ${r.deadline}`);
        return parts.join(" | ");
    })
        .join("\n");
}
async function execCreateCalendarEvent(input, ctx, collector) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    const startRaw = typeof input.start_iso === "string" ? input.start_iso : "";
    if (!title || !startRaw)
        return "parâmetros em falta";
    if (!calendar.isAuthenticated()) {
        await ctx.reply("Google Calendar não está autenticado. Usa /auth para configurar.");
        return "não autenticado";
    }
    const startUtc = lisbonLocalToUtc(startRaw);
    const startDate = new Date(startUtc);
    log.info("assistant.calendar_event_times", { startRaw, startUtc, startIso: startDate.toISOString() });
    if (Number.isNaN(startDate.getTime()))
        return "data de início inválida";
    let endDate;
    if (typeof input.end_iso === "string" && input.end_iso) {
        endDate = new Date(lisbonLocalToUtc(input.end_iso));
    }
    else {
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
    }
    const description = typeof input.description === "string" ? input.description : undefined;
    let calendarId;
    if (typeof input.calendar_name === "string" && input.calendar_name) {
        const cals = await calendar.listAllCalendars();
        const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s]/g, " ").trim();
        const q = normalize(input.calendar_name);
        const qWords = q.split(/\s+/).filter(Boolean);
        const match = cals.find((c) => normalize(c.summary) === q) ??
            cals.find((c) => normalize(c.summary).includes(q) || q.includes(normalize(c.summary))) ??
            cals.find((c) => {
                const cWords = normalize(c.summary).split(/\s+/).filter(Boolean);
                return qWords.some((w) => cWords.includes(w));
            });
        if (match) {
            calendarId = match.id;
        }
        else {
            log.warn("assistant.calendar_not_found", { query: input.calendar_name, available: cals.map((c) => c.summary) });
        }
    }
    const event = await calendar.createEvent({ title, start: startDate, end: endDate, description, calendarId });
    if (!event) {
        await ctx.reply("erro ao criar evento no Google Calendar");
        return "erro";
    }
    const startLabel = startDate.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon", dateStyle: "short", timeStyle: "short" });
    const reply = `📅 evento criado: "${title}" — ${startLabel}`;
    collector.push(reply);
    await ctx.reply(reply);
    return "ok";
}
async function execCreateEntity(input, sender, ctx, collector) {
    const kind = ENTITY_KINDS.includes(input.kind)
        ? input.kind
        : null;
    if (!kind)
        return "parâmetros em falta";
    const nome = typeof input.nome === "string" ? input.nome.trim() : "";
    if (!nome)
        return "parâmetros em falta";
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
            await notion.createInfluencer(nome, owner, ctx.message?.text ?? "");
            break;
    }
    log.info("assistant.entity_created", { kind, nome, owner, sender: sender });
    const entityReply = `✅ ${kindLabel[kind]} criado: "${nome}"`;
    collector.push(entityReply);
    await ctx.reply(entityReply);
    return "ok";
}
async function dispatchTool(name, input, sender, ctx, collector) {
    switch (name) {
        case "search_records":
            return await execSearchRecords(input);
        case "create_task":
            return await execCreateTask(input, sender, ctx, collector);
        case "create_reminder":
            return await execCreateReminder(input, sender, ctx, collector);
        case "cancel_reminder":
            return await execCancelReminder(input, ctx, collector);
        case "log_decision":
            return await execLogDecision(input, sender, ctx, collector);
        case "add_to_discuss":
            return await execAddToDiscuss(input, sender, ctx, collector);
        case "set_focus":
            return await execSetFocus(input, sender, ctx, collector);
        case "log_entry":
            return await execLogEntry(input, sender, ctx, collector);
        case "add_to_list":
            return await execAddToList(input, sender, ctx, collector);
        case "create_content_calendar_entry":
            return await execCreateContentCalendarEntry(input, sender, ctx, collector);
        case "check_list_item":
            return await execCheckListItem(input, ctx, collector);
        case "delete_list_item":
            return await execDeleteListItem(input, ctx, collector);
        case "update_record":
            return await execUpdateRecord(input, ctx, collector);
        case "add_to_page_section":
            return await execAddToPageSection(input, ctx, collector);
        case "create_calendar_event":
            return await execCreateCalendarEvent(input, ctx, collector);
        case "create_entity":
            return await execCreateEntity(input, sender, ctx, collector);
        default:
            log.warn("assistant.unknown_tool", { name });
            return `tool desconhecida: ${name}`;
    }
}
export async function handleAssistant(ctx, sender, text, recentMessages, repliedToText, contentCalendar, lastBotReplies, openTasks) {
    const collector = [];
    let runtime;
    try {
        runtime = initRuntime();
    }
    catch (err) {
        log.error("assistant.init_failed", { err: String(err) });
        return collector;
    }
    const systemBlocks = [
        {
            type: "text",
            text: runtime.systemPrompt,
            cache_control: { type: "ephemeral" },
        },
    ];
    const availableCalendars = calendar.isAuthenticated()
        ? await calendar.listAllCalendars().catch(() => [])
        : [];
    const availableLists = await notion.getListNames().catch(() => []);
    const messages = [
        {
            role: "user",
            content: buildUserMessage(sender, text, recentMessages, repliedToText, contentCalendar, lastBotReplies, openTasks, availableCalendars, availableLists),
        },
    ];
    const MAX_ITERATIONS = 5;
    const allToolNames = [];
    // True once any action tool (non-search) has run and sent its own confirmation.
    // Used to suppress the model's closing text in the next iteration.
    let actionsPerformed = false;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let response;
        try {
            response = await runtime.client.messages.create({
                model: runtime.model,
                max_tokens: MAX_TOKENS,
                system: systemBlocks,
                tools: TOOLS,
                messages,
            });
        }
        catch (err) {
            log.error("assistant.api_error", { err: String(err) });
            break;
        }
        const toolCalls = response.content.filter((b) => b.type === "tool_use");
        // Send text only when:
        // - No tool calls in this response (pure informational reply), AND
        // - No action tools have already confirmed via their own reply.
        // This prevents both "text + tool_use in same response" and
        // "model closes with text after action tools already replied".
        if (toolCalls.length === 0 && !actionsPerformed) {
            for (const block of response.content) {
                if (block.type === "text" && block.text.trim() && !isSilenceResponse(block.text)) {
                    try {
                        collector.push(block.text.trim());
                        await ctx.reply(block.text.trim());
                    }
                    catch (err) {
                        log.warn("assistant.reply_failed", { err: String(err) });
                    }
                }
            }
        }
        if (toolCalls.length === 0 || response.stop_reason === "end_turn")
            break;
        // Execute tools and collect results for next turn
        const toolResults = [];
        for (const block of toolCalls) {
            if (block.type !== "tool_use")
                continue;
            allToolNames.push(block.name);
            const input = block.input;
            let result;
            try {
                result = await dispatchTool(block.name, input, sender, ctx, collector);
            }
            catch (err) {
                log.error("assistant.tool_failed", { tool: block.name, err: String(err) });
                result = `erro: ${String(err)}`;
                try {
                    await ctx.reply("erro a executar ação — tenta outra vez");
                }
                catch { /* ignore */ }
            }
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
            if (block.name !== "search_records")
                actionsPerformed = true;
        }
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
    }
    log.info("assistant.handled", { sender, tools: allToolNames });
    return collector;
}
