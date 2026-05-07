/**
 * Notion API wrapper.
 *
 * Singleton `notion` exposing typed methods for Master Backlog and
 * Bot Feedback databases. All methods retry on 429 / 5xx with
 * exponential backoff (3 attempts: 0.5s, 2s, 8s).
 *
 * Caching:
 * - `getOpenTasks` cached 60s (module scope).
 * - `getRecentFeedback` cached 5min (module scope).
 * - Caches invalidated explicitly via `invalidateOpenTasksCache`
 *   after writes.
 */
import { Client, APIResponseError } from "@notionhq/client";
import { log } from "./lib/log.js";
// ----- env -----
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_BACKLOG_DB_ID = process.env.NOTION_BACKLOG_DB_ID;
// Phase 2/3/5 — all optional
const NOTION_FOUNDER_FOCUS_DB_ID = process.env.NOTION_FOUNDER_FOCUS_DB_ID;
const NOTION_PARTNER_DB_ID = process.env.NOTION_PARTNER_DB_ID;
const NOTION_INFLUENCER_DB_ID = process.env.NOTION_INFLUENCER_DB_ID;
const NOTION_REMINDERS_DB_ID = process.env.NOTION_REMINDERS_DB_ID;
const NOTION_TO_DISCUSS_DB_ID = process.env.NOTION_TO_DISCUSS_DB_ID;
const NOTION_DECISIONS_DB_ID = process.env.NOTION_DECISIONS_DB_ID;
const NOTION_CONTENT_CALENDAR_DB_ID = process.env.NOTION_CONTENT_CALENDAR_DB_ID;
const NOTION_STUDIO_LOG_DB_ID = process.env.NOTION_STUDIO_LOG_DB_ID;
const NOTION_PROJECTS_DB_ID = process.env.NOTION_PROJECTS_DB_ID;
const NOTION_EVENT_DB_ID = process.env.NOTION_EVENT_DB_ID;
const NOTION_LISTS_DB_ID = process.env.NOTION_LISTS_DB_ID;
if (!NOTION_API_KEY) {
    throw new Error("notion: NOTION_API_KEY is required");
}
if (!NOTION_BACKLOG_DB_ID) {
    throw new Error("notion: NOTION_BACKLOG_DB_ID is required");
}
const client = new Client({ auth: NOTION_API_KEY });
// ----- retry helper -----
const RETRY_DELAYS_MS = [500, 2000, 8000];
function isRetriable(err) {
    if (err instanceof APIResponseError) {
        if (err.status === 429)
            return true;
        if (err.status >= 500 && err.status < 600)
            return true;
        return false;
    }
    // Network or unknown errors → retry once
    return true;
}
async function withRetry(label, fn) {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            lastErr = err;
            const retriable = isRetriable(err);
            const isLastAttempt = attempt === RETRY_DELAYS_MS.length;
            if (!retriable || isLastAttempt) {
                log.error("notion.error", {
                    label,
                    attempt: attempt + 1,
                    status: err instanceof APIResponseError ? err.status : undefined,
                    message: err instanceof Error ? err.message : String(err),
                });
                throw err;
            }
            const delay = RETRY_DELAYS_MS[attempt];
            log.warn("notion.retry", {
                label,
                attempt: attempt + 1,
                delayMs: delay,
                status: err instanceof APIResponseError ? err.status : undefined,
            });
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw lastErr;
}
// ----- caches -----
const OPEN_TASKS_TTL_MS = 60 * 1000;
let openTasksCache = null;
const WEEKLY_PRIORITIES_TTL_MS = 60 * 1000;
const OVERDUE_TTL_MS = 60 * 1000;
let weeklyPrioritiesCache = null;
let overdueCache = null;
function invalidateOpenTasksCache() {
    openTasksCache = null;
    weeklyPrioritiesCache = null;
    overdueCache = null;
}
// ----- property mapping -----
const FIELD_TO_PROPERTY = {
    status: "Status",
    owner: "Owner",
    deadline: "Deadline",
    prioridade: "Prioridade",
    area: "Área",
};
// ----- helpers -----
function richText(text) {
    // Notion limits rich_text content to 2000 chars per chunk.
    const chunks = [];
    for (let i = 0; i < text.length; i += 2000) {
        chunks.push(text.slice(i, i + 2000));
    }
    return {
        rich_text: chunks.map((content) => ({ text: { content } })),
    };
}
function readPlainText(prop) {
    if (prop &&
        typeof prop === "object" &&
        "rich_text" in prop &&
        Array.isArray(prop.rich_text)) {
        return (prop.rich_text)
            .map((r) => r.plain_text ?? "")
            .join("");
    }
    if (prop &&
        typeof prop === "object" &&
        "title" in prop &&
        Array.isArray(prop.title)) {
        return (prop.title)
            .map((r) => r.plain_text ?? "")
            .join("");
    }
    return "";
}
function readSelectName(prop) {
    if (prop &&
        typeof prop === "object" &&
        "select" in prop &&
        prop.select &&
        typeof prop.select === "object") {
        return prop.select.name ?? null;
    }
    return null;
}
function readMultiSelectFirst(prop) {
    if (prop &&
        typeof prop === "object" &&
        "multi_select" in prop &&
        Array.isArray(prop.multi_select)) {
        const first = prop.multi_select[0];
        return first?.name ?? null;
    }
    return null;
}
function readStatusName(prop) {
    if (prop &&
        typeof prop === "object" &&
        "status" in prop &&
        prop.status &&
        typeof prop.status === "object") {
        return prop.status.name ?? null;
    }
    return null;
}
function readDateStart(prop) {
    if (prop &&
        typeof prop === "object" &&
        "date" in prop &&
        prop.date &&
        typeof prop.date === "object") {
        return prop.date.start ?? null;
    }
    return null;
}
function readCheckbox(prop) {
    if (prop &&
        typeof prop === "object" &&
        "checkbox" in prop &&
        typeof prop.checkbox === "boolean") {
        return prop.checkbox;
    }
    return false;
}
function readMultiSelectNames(prop) {
    if (prop &&
        typeof prop === "object" &&
        "multi_select" in prop &&
        Array.isArray(prop.multi_select)) {
        return prop.multi_select
            .map((m) => m.name ?? "")
            .filter((n) => n.length > 0);
    }
    return [];
}
function readUrl(prop) {
    if (prop &&
        typeof prop === "object" &&
        "url" in prop &&
        typeof prop.url === "string") {
        return prop.url;
    }
    return null;
}
function readDateTime(prop) {
    // Same as readDateStart but kept for clarity
    return readDateStart(prop);
}
function readFormulaString(prop) {
    if (prop &&
        typeof prop === "object" &&
        "formula" in prop &&
        prop.formula &&
        typeof prop.formula === "object") {
        return prop.formula.string ?? null;
    }
    return null;
}
function buildEditPatch(field, newValue) {
    const property = FIELD_TO_PROPERTY[field];
    switch (field) {
        case "status":
            return { [property]: { select: { name: newValue } } };
        case "owner":
            return { [property]: { multi_select: [{ name: newValue }] } };
        case "prioridade":
        case "area":
            return { [property]: { select: { name: newValue } } };
        case "deadline":
            return newValue === "none"
                ? { [property]: { date: null } }
                : { [property]: { date: { start: newValue } } };
    }
}
// ----- entity relation helpers -----
const ENTITY_KIND_TO_FIELD = {
    projeto: "Projects",
    evento: "Events Pipeline",
    parceria: "Partner Pipeline",
    influencer: "Influencer Pipeline",
};
async function findEntityByName(kind, nome) {
    const dbId = kind === "projeto" ? NOTION_PROJECTS_DB_ID
        : kind === "evento" ? NOTION_EVENT_DB_ID
            : kind === "parceria" ? NOTION_PARTNER_DB_ID
                : NOTION_INFLUENCER_DB_ID;
    if (!dbId)
        return null;
    try {
        const res = await withRetry("findEntityByName", () => client.databases.query({
            database_id: dbId,
            filter: { property: "Name", title: { contains: nome } },
            page_size: 1,
        }));
        return res.results[0]?.id ?? null;
    }
    catch (err) {
        log.warn("notion.find_entity_failed", { kind, nome, err: String(err) });
        return null;
    }
}
async function entityRelationProps(entityRef) {
    if (!entityRef)
        return {};
    const pageId = await findEntityByName(entityRef.kind, entityRef.nome);
    if (!pageId)
        return {};
    return { [ENTITY_KIND_TO_FIELD[entityRef.kind]]: { relation: [{ id: pageId }] } };
}
// ----- methods -----
async function createTask(extraction, priority, originalMsg, sender, entityRef, deadline) {
    const relProps = await entityRelationProps(entityRef);
    const props = {
        "Título": { title: [{ text: { content: extraction.title } }] },
        Owner: { multi_select: [{ name: extraction.owner }] },
        "Área": { select: { name: extraction.area } },
        Prioridade: { select: { name: priority } },
        Status: { select: { name: "A fazer" } },
        Origem: richText(originalMsg),
        ...relProps,
    };
    if (deadline)
        props["Deadline"] = { date: { start: deadline } };
    const page = await withRetry("createTask", () => client.pages.create({
        parent: { database_id: NOTION_BACKLOG_DB_ID },
        properties: props,
    }));
    invalidateOpenTasksCache();
    log.info("notion.task_created", {
        pageId: page.id,
        title: extraction.title,
        owner: extraction.owner,
        priority,
    });
    return page.id;
}
async function updateTask(pageId, field, newValue) {
    const properties = buildEditPatch(field, newValue);
    await withRetry("updateTask", () => client.pages.update({
        page_id: pageId,
        properties: properties,
    }));
    invalidateOpenTasksCache();
    log.info("notion.task_updated", { pageId, field, newValue });
}
const RECORD_DB_CONFIGS = {
    to_discuss: {
        dbId: () => NOTION_TO_DISCUSS_DB_ID,
        titleProp: "Tema",
        fields: {
            urgencia: { notionProp: "Urgência", type: "select" },
            estado: { notionProp: "Estado", type: "select" },
            area: { notionProp: "Área", type: "select" },
            resolucao: { notionProp: "Resolução", type: "rich_text" },
        },
    },
    decisions: {
        dbId: () => NOTION_DECISIONS_DB_ID,
        titleProp: "Decisão",
        fields: {
            estado: { notionProp: "Estado", type: "select" },
            area: { notionProp: "Área", type: "select" },
            notas: { notionProp: "Notas", type: "rich_text" },
        },
    },
    content_calendar: {
        dbId: () => NOTION_CONTENT_CALENDAR_DB_ID,
        titleProp: "Name",
        fields: {
            status: { notionProp: "status", type: "status" },
            publish_date: { notionProp: "Posting Haven", type: "date" },
            ad_type: { notionProp: "Ad type", type: "select" },
        },
    },
    partners: {
        dbId: () => NOTION_PARTNER_DB_ID,
        titleProp: "Name",
        fields: {
            status: { notionProp: "Status", type: "select" },
            owner: { notionProp: "Owner", type: "select" },
        },
    },
    influencers: {
        dbId: () => NOTION_INFLUENCER_DB_ID,
        titleProp: "Name",
        fields: {
            status: { notionProp: "Status", type: "select" },
            owner: { notionProp: "Owner", type: "select" },
        },
    },
    events: {
        dbId: () => NOTION_EVENT_DB_ID,
        titleProp: "Name",
        fields: {
            status: { notionProp: "Status", type: "select" },
            owner: { notionProp: "Owner", type: "multi_select" },
        },
    },
    projects: {
        dbId: () => NOTION_PROJECTS_DB_ID,
        titleProp: "Name",
        fields: {
            status: { notionProp: "Status", type: "select" },
            owner: { notionProp: "Owner", type: "multi_select" },
        },
    },
};
async function findRecordByTitle(dbId, titleProp, query) {
    const res = await withRetry("findRecordByTitle", () => client.databases.query({
        database_id: dbId,
        filter: { property: titleProp, title: { contains: query } },
        page_size: 5,
    }));
    const pages = res.results.filter((r) => "properties" in r);
    if (pages.length === 0)
        return null;
    const firstPage = pages[0];
    const title = readPlainText(firstPage.properties[titleProp]);
    return { id: firstPage.id, title };
}
async function updateRecord(db, itemTitle, field, newValue) {
    const config = RECORD_DB_CONFIGS[db];
    if (!config)
        throw new Error(`Unknown db: ${db}`);
    const dbId = config.dbId();
    if (!dbId)
        throw new Error(`DB ${db} not configured`);
    const fieldConfig = config.fields[field];
    if (!fieldConfig)
        throw new Error(`Unknown field '${field}' for db '${db}'`);
    const found = await findRecordByTitle(dbId, config.titleProp, itemTitle);
    if (!found)
        return null;
    let propValue;
    switch (fieldConfig.type) {
        case "select":
            propValue = { select: { name: newValue } };
            break;
        case "multi_select":
            propValue = { multi_select: [{ name: newValue }] };
            break;
        case "status":
            propValue = { status: { name: newValue } };
            break;
        case "date":
            propValue = { date: { start: newValue } };
            break;
        case "rich_text":
            propValue = richText(newValue);
            break;
    }
    await withRetry("updateRecord", () => client.pages.update({
        page_id: found.id,
        properties: {
            [fieldConfig.notionProp]: propValue,
        },
    }));
    log.info("notion.record_updated", { db, title: found.title, field, newValue });
    return { pageId: found.id, title: found.title };
}
async function archivePage(pageId) {
    await withRetry("archivePage", () => client.pages.update({ page_id: pageId, archived: true }));
    invalidateOpenTasksCache();
    log.info("notion.page_archived", { pageId });
}
async function getOpenTasks() {
    const now = Date.now();
    if (openTasksCache && openTasksCache.expiresAt > now) {
        return openTasksCache.value;
    }
    const tasks = [];
    let cursor;
    do {
        const res = await withRetry("getOpenTasks", () => client.databases.query({
            database_id: NOTION_BACKLOG_DB_ID,
            filter: {
                and: [
                    { property: "Status", select: { does_not_equal: "Feito" } },
                    { property: "Status", select: { does_not_equal: "Cancelado" } },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            const props = row.properties;
            const title = readPlainText(props["Título"]);
            const owner = (readMultiSelectFirst(props["Owner"]) ?? "Unassigned");
            const area = (readSelectName(props["Área"]) ?? "Outro");
            const priorityName = readSelectName(props["Prioridade"]);
            const priority = priorityName === "Alta" || priorityName === "Média" || priorityName === "Baixa"
                ? priorityName
                : null;
            const deadline = readDateStart(props["Deadline"]);
            const statusName = readSelectName(props["Status"]) ?? "A fazer";
            const status = statusName;
            tasks.push({
                id: row.id,
                title,
                owner,
                area,
                priority,
                deadline,
                status,
            });
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    openTasksCache = { value: tasks, expiresAt: now + OPEN_TASKS_TTL_MS };
    log.debug("notion.open_tasks_fetched", { count: tasks.length });
    return tasks;
}
// ============================================================
// Phase 2 — Weekly cycle
// ============================================================
function rowToOpenTask(row) {
    const props = row.properties;
    const title = readPlainText(props["Título"]);
    const owner = (readMultiSelectFirst(props["Owner"]) ?? "Unassigned");
    const area = (readSelectName(props["Área"]) ?? "Outro");
    const priorityName = readSelectName(props["Prioridade"]);
    const priority = priorityName === "Alta" || priorityName === "Média" || priorityName === "Baixa"
        ? priorityName
        : null;
    const deadline = readDateStart(props["Deadline"]);
    const statusName = readSelectName(props["Status"]) ?? "A fazer";
    return {
        id: row.id,
        title,
        owner,
        area,
        priority,
        deadline,
        status: statusName,
    };
}
async function getOpenTasksFor(owner) {
    const all = await getOpenTasks();
    return all.filter((t) => t.owner === owner);
}
async function getWeeklyPriorities(week) {
    const now = Date.now();
    if (weeklyPrioritiesCache &&
        weeklyPrioritiesCache.week === week &&
        weeklyPrioritiesCache.expiresAt > now) {
        return weeklyPrioritiesCache.value;
    }
    const tasks = [];
    let cursor;
    do {
        const res = await withRetry("getWeeklyPriorities", () => client.databases.query({
            database_id: NOTION_BACKLOG_DB_ID,
            filter: {
                and: [
                    { property: "Prioridade semanal", checkbox: { equals: true } },
                    { property: "Status", select: { does_not_equal: "Feito" } },
                    { property: "Status", select: { does_not_equal: "Cancelado" } },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            // Match by Semana formula string
            const props = row.properties;
            const semana = readFormulaString(props["Semana"]);
            if (semana !== null && semana !== week)
                continue;
            tasks.push(rowToOpenTask({ id: row.id, properties: props }));
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    weeklyPrioritiesCache = {
        week,
        value: tasks,
        expiresAt: now + WEEKLY_PRIORITIES_TTL_MS,
    };
    log.debug("notion.weekly_priorities_fetched", { week, count: tasks.length });
    return tasks;
}
async function setWeeklyPriority(taskId, value) {
    await withRetry("setWeeklyPriority", () => client.pages.update({
        page_id: taskId,
        properties: {
            "Prioridade semanal": { checkbox: value },
        },
    }));
    weeklyPrioritiesCache = null;
    log.info("notion.weekly_priority_set", { taskId, value });
}
async function getCompletedSince(date) {
    const tasks = [];
    let cursor;
    do {
        const res = await withRetry("getCompletedSince", () => client.databases.query({
            database_id: NOTION_BACKLOG_DB_ID,
            filter: {
                and: [
                    { property: "Status", select: { equals: "Feito" } },
                    {
                        timestamp: "last_edited_time",
                        last_edited_time: { on_or_after: date },
                    },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            tasks.push(rowToOpenTask({
                id: row.id,
                properties: row.properties,
            }));
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    log.debug("notion.completed_since_fetched", { since: date, count: tasks.length });
    return tasks;
}
async function getOverdueTasks() {
    const now = Date.now();
    if (overdueCache && overdueCache.expiresAt > now) {
        return overdueCache.value;
    }
    const today = new Date().toISOString().slice(0, 10);
    const tasks = [];
    let cursor;
    do {
        const res = await withRetry("getOverdueTasks", () => client.databases.query({
            database_id: NOTION_BACKLOG_DB_ID,
            filter: {
                and: [
                    { property: "Deadline", date: { before: today } },
                    { property: "Status", select: { does_not_equal: "Feito" } },
                    { property: "Status", select: { does_not_equal: "Cancelado" } },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            tasks.push(rowToOpenTask({
                id: row.id,
                properties: row.properties,
            }));
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    overdueCache = { value: tasks, expiresAt: now + OVERDUE_TTL_MS };
    log.debug("notion.overdue_fetched", { count: tasks.length });
    return tasks;
}
async function setFounderFocus(entry) {
    if (!NOTION_FOUNDER_FOCUS_DB_ID) {
        throw new Error("NOTION_FOUNDER_FOCUS_DB_ID not set");
    }
    // Always create — latest entry per founder is the active focus.
    await withRetry("setFounderFocus", () => client.pages.create({
        parent: { database_id: NOTION_FOUNDER_FOCUS_DB_ID },
        properties: {
            Name: { title: [{ text: { content: entry.focoOperacional.slice(0, 80) } }] },
            Founder: { select: { name: entry.founder } },
            "Foco operacional": richText(entry.focoOperacional),
            Ativo: { checkbox: true },
        },
    }));
    log.info("notion.founder_focus_created", { founder: entry.founder, semana: entry.semana });
}
async function getFounderFocusForWeek(week) {
    if (!NOTION_FOUNDER_FOCUS_DB_ID)
        return [];
    const res = await withRetry("getFounderFocusForWeek", () => client.databases.query({
        database_id: NOTION_FOUNDER_FOCUS_DB_ID,
        filter: { property: "Semana", formula: { string: { equals: week } } },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
    }));
    // Latest entry per founder is the active focus.
    const seen = new Set();
    const entries = [];
    for (const row of res.results) {
        if (!("properties" in row))
            continue;
        const props = row.properties;
        const founderName = readSelectName(props["Founder"]);
        if (founderName !== "Madalena" && founderName !== "Mafalda" && founderName !== "Beatriz")
            continue;
        if (seen.has(founderName))
            continue;
        seen.add(founderName);
        entries.push({
            founder: founderName,
            semana: readPlainText(props["Semana"]) || week,
            focoOperacional: readPlainText(props["Foco operacional"]),
        });
    }
    log.debug("notion.founder_focus_fetched", { week, count: entries.length });
    return entries;
}
// ============================================================
// Phase 3 — Partners / Influencers / Content / Reminders
// ============================================================
const PARTNER_NO_RESPONSE_DAYS = 7;
const PARTNER_NO_PROGRESS_DAYS = 3;
function daysAgo(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
}
async function getPartnersStale(category) {
    if (!NOTION_PARTNER_DB_ID) {
        throw new Error("NOTION_PARTNER_DB_ID not set — Phase 3 partner features disabled");
    }
    const cutoff = category === "no_response"
        ? daysAgo(PARTNER_NO_RESPONSE_DAYS)
        : daysAgo(PARTNER_NO_PROGRESS_DAYS);
    const statusFilter = category === "no_response"
        ? {
            or: [
                { property: "Status", select: { equals: "Contactado" } },
                { property: "Status", select: { equals: "A aguardar resposta" } },
            ],
        }
        : { property: "Status", select: { equals: "Em negociação" } };
    const rows = [];
    let cursor;
    do {
        const res = await withRetry("getPartnersStale", () => client.databases.query({
            database_id: NOTION_PARTNER_DB_ID,
            filter: {
                and: [
                    statusFilter,
                    { property: "Último contacto", date: { before: cutoff } },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            const props = row.properties;
            const cat = readSelectName(props["Categoria"]);
            const status = readSelectName(props["Status"]);
            rows.push({
                id: row.id,
                nome: readPlainText(props["Name"]),
                categoria: cat,
                owner: (readSelectName(props["Owner"]) ?? "Unassigned"),
                status,
                ultimoContacto: readDateStart(props["Último contacto"]),
                proximoPasso: readPlainText(props["Próximo passo"]),
                notas: readPlainText(props["Notas"]),
            });
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    log.debug("notion.partners_stale_fetched", { category, count: rows.length });
    return rows;
}
const INFLUENCER_NO_RESPONSE_DAYS = 7;
const INFLUENCER_NO_PROGRESS_DAYS = 3;
async function getInfluencersStale(category) {
    if (!NOTION_INFLUENCER_DB_ID) {
        throw new Error("NOTION_INFLUENCER_DB_ID not set — Phase 3 influencer features disabled");
    }
    const cutoff = category === "no_response"
        ? daysAgo(INFLUENCER_NO_RESPONSE_DAYS)
        : daysAgo(INFLUENCER_NO_PROGRESS_DAYS);
    // Influencer does not have a literal "A aguardar resposta" status; map
    // "no_response" → Contactado (no reply), "no_progress" → Em conversa stalled.
    const statusFilter = category === "no_response"
        ? { property: "Status", select: { equals: "Contactado" } }
        : { property: "Status", select: { equals: "Em conversa" } };
    const rows = [];
    let cursor;
    do {
        const res = await withRetry("getInfluencersStale", () => client.databases.query({
            database_id: NOTION_INFLUENCER_DB_ID,
            filter: {
                and: [
                    statusFilter,
                    { property: "Último contacto", date: { before: cutoff } },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            const props = row.properties;
            const status = readSelectName(props["Status"]);
            rows.push({
                id: row.id,
                nome: readPlainText(props["Name"]),
                instagram: readUrl(props["Instagram"]),
                owner: (readSelectName(props["Owner"]) ?? "Unassigned"),
                status,
                ultimoContacto: readDateStart(props["Último contacto"]),
                proximoPasso: readPlainText(props["Próximo passo"]),
                notas: readPlainText(props["Notas"]),
            });
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    log.debug("notion.influencers_stale_fetched", { category, count: rows.length });
    return rows;
}
async function getContentCalendarAlerts() {
    const empty = {
        hours_to_publish_unscheduled: [],
        editing_too_long: [],
        ideation_stale: [],
    };
    if (!NOTION_CONTENT_CALENDAR_DB_ID) {
        return empty;
    }
    try {
        const rows = [];
        let cursor;
        do {
            const res = await withRetry("getContentCalendarAlerts", () => client.databases.query({
                database_id: NOTION_CONTENT_CALENDAR_DB_ID,
                start_cursor: cursor,
            }));
            for (const row of res.results) {
                if (!("properties" in row))
                    continue;
                rows.push({
                    id: row.id,
                    properties: row.properties,
                });
            }
            cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
        } while (cursor);
        const now = Date.now();
        const hoursToPublishUnscheduled = [];
        const editingTooLong = [];
        const ideationStale = [];
        for (const row of rows) {
            try {
                const props = row.properties;
                // Defensive: try common property names (unknown schema)
                const status = readSelectName(props["Status"]) ??
                    readStatusName(props["Status"]) ??
                    readSelectName(props["status"]);
                const publishDate = readDateStart(props["Data publicação"]) ??
                    readDateStart(props["Publish date"]) ??
                    readDateStart(props["Data"]);
                const lastEdited = readDateStart(props["Last edited"]) ??
                    readDateStart(props["Atualizado em"]);
                if (publishDate) {
                    const ms = new Date(publishDate).getTime() - now;
                    const hours = ms / (1000 * 60 * 60);
                    if (hours > 0 && hours < 24 && status !== "Agendado") {
                        hoursToPublishUnscheduled.push(row);
                    }
                    if (hours > 0 &&
                        hours < 48 &&
                        (status === "Em edição" || status === "Editing")) {
                        editingTooLong.push(row);
                    }
                }
                if (status === "Ideação" || status === "Ideation") {
                    const reference = lastEdited
                        ? new Date(lastEdited).getTime()
                        : null;
                    if (reference !== null) {
                        const ageDays = (now - reference) / (1000 * 60 * 60 * 24);
                        if (ageDays > 14)
                            ideationStale.push(row);
                    }
                }
            }
            catch (err) {
                log.warn("notion.content_calendar_row_skipped", {
                    rowId: row.id,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return {
            hours_to_publish_unscheduled: hoursToPublishUnscheduled,
            editing_too_long: editingTooLong,
            ideation_stale: ideationStale,
        };
    }
    catch (err) {
        log.warn("notion.content_calendar_alerts_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        return empty;
    }
}
async function getContentCalendarRows() {
    if (!NOTION_CONTENT_CALENDAR_DB_ID)
        return [];
    try {
        const rows = [];
        let cursor;
        do {
            const res = await withRetry("getContentCalendarRows", () => client.databases.query({
                database_id: NOTION_CONTENT_CALENDAR_DB_ID,
                start_cursor: cursor,
            }));
            for (const row of res.results) {
                if (!("properties" in row))
                    continue;
                const props = row.properties;
                const title = readPlainText(props["Name"] ?? props["Título"] ?? props["Title"] ?? props["name"]);
                const status = readStatusName(props["status"]) ??
                    readSelectName(props["status"]) ??
                    readStatusName(props["Status"]) ??
                    readSelectName(props["Status"]) ?? null;
                const publishDate = readDateStart(props["Posting Haven"]) ??
                    readDateStart(props["Data publicação"]) ??
                    readDateStart(props["Publish date"]) ??
                    readDateStart(props["Data"]) ?? null;
                const adType = readSelectName(props["Ad type"]) ?? null;
                rows.push({ id: row.id, title, status, publishDate, platform: adType, owner: null });
            }
            cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
        } while (cursor);
        return rows;
    }
    catch (err) {
        log.warn("notion.content_calendar_rows_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
async function createContentCalendarEntry(params) {
    if (!NOTION_CONTENT_CALENDAR_DB_ID) {
        throw new Error("notion: NOTION_CONTENT_CALENDAR_DB_ID is not configured");
    }
    const properties = {
        Name: { title: [{ text: { content: params.title } }] },
        status: { status: { name: params.status ?? "Raw Idea" } },
    };
    if (params.publishDate) {
        properties["Posting Haven"] = { date: { start: params.publishDate } };
    }
    if (params.adType) {
        properties["Ad type"] = { select: { name: params.adType } };
    }
    if (params.originalMsg) {
        properties["Origem"] = richText(params.originalMsg);
    }
    const page = await withRetry("createContentCalendarEntry", () => client.pages.create({
        parent: { database_id: NOTION_CONTENT_CALENDAR_DB_ID },
        properties: properties,
    }));
    log.info("notion.content_calendar_entry_created", { title: params.title });
    return page.id;
}
// ── Studio Log (Phase 1 redesign) ────────────────────────────────────────────
async function createLogEntry(params) {
    if (!NOTION_STUDIO_LOG_DB_ID) {
        throw new Error("NOTION_STUDIO_LOG_DB_ID not set — Studio Log features disabled");
    }
    const properties = {
        Texto: { title: [{ text: { content: params.text } }] },
        Data: { date: { start: new Date().toISOString() } },
        Autor: { select: { name: params.author } },
        Tags: {
            multi_select: params.tags.slice(0, 3).map((name) => ({ name })),
        },
        "Mensagem original": richText(params.originalMessage),
    };
    const page = await withRetry("createLogEntry", () => client.pages.create({
        parent: { database_id: NOTION_STUDIO_LOG_DB_ID },
        properties: properties,
    }));
    log.info("notion.log_entry_created", { id: page.id, author: params.author });
    return page.id;
}
async function createReminder(r) {
    if (!NOTION_REMINDERS_DB_ID) {
        throw new Error("NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled");
    }
    const properties = {
        Texto: { title: [{ text: { content: r.texto } }] },
        "Para quem": { multi_select: [{ name: r.paraQuem }] },
        Quando: { date: { start: r.quando } },
        Origem: richText(r.origem),
        Enviado: { checkbox: false },
    };
    const page = await withRetry("createReminder", () => client.pages.create({
        parent: { database_id: NOTION_REMINDERS_DB_ID },
        properties: properties,
    }));
    log.info("notion.reminder_created", { id: page.id, paraQuem: r.paraQuem });
    return page.id;
}
async function getDueReminders() {
    if (!NOTION_REMINDERS_DB_ID) {
        throw new Error("NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled");
    }
    const now = new Date().toISOString();
    const rows = [];
    let cursor;
    do {
        const res = await withRetry("getDueReminders", () => client.databases.query({
            database_id: NOTION_REMINDERS_DB_ID,
            filter: {
                and: [
                    { property: "Enviado", checkbox: { equals: false } },
                    { property: "Quando", date: { on_or_before: now } },
                ],
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            const props = row.properties;
            const paraQuem = readMultiSelectFirst(props["Para quem"]);
            if (paraQuem !== "Madalena" &&
                paraQuem !== "Mafalda" &&
                paraQuem !== "Beatriz") {
                continue;
            }
            rows.push({
                id: row.id,
                texto: readPlainText(props["Texto"]),
                paraQuem,
                quando: readDateStart(props["Quando"]) ?? "",
                origem: readPlainText(props["Origem"]),
                enviado: readCheckbox(props["Enviado"]),
            });
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    log.debug("notion.due_reminders_fetched", { count: rows.length });
    return rows;
}
async function markReminderSent(id) {
    if (!NOTION_REMINDERS_DB_ID) {
        throw new Error("NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled");
    }
    await withRetry("markReminderSent", () => client.pages.update({
        page_id: id,
        properties: {
            Enviado: { checkbox: true },
        },
    }));
    log.info("notion.reminder_marked_sent", { id });
}
// ============================================================
// Phase 5 — To Discuss / Decisions
// ============================================================
async function createToDiscuss(item, originalMsg) {
    if (!NOTION_TO_DISCUSS_DB_ID) {
        throw new Error("NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled");
    }
    const properties = {
        Tema: { title: [{ text: { content: item.tema } }] },
        "Adicionado por": { select: { name: item.adicionadoPor } },
        Urgência: { select: { name: item.urgencia } },
        Área: { select: { name: item.area } },
        Estado: { select: { name: "Pendente" } },
        Origem: richText(originalMsg),
    };
    if (item.resolucao) {
        properties["Resolução"] = richText(item.resolucao);
    }
    if (item.deadline) {
        properties["Deadline"] = { date: { start: item.deadline } };
    }
    const page = await withRetry("createToDiscuss", () => client.pages.create({
        parent: { database_id: NOTION_TO_DISCUSS_DB_ID },
        properties: properties,
    }));
    log.info("notion.to_discuss_created", {
        id: page.id,
        adicionadoPor: item.adicionadoPor,
    });
    return page.id;
}
async function getToDiscussPending() {
    if (!NOTION_TO_DISCUSS_DB_ID) {
        throw new Error("NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled");
    }
    const rows = [];
    let cursor;
    do {
        const res = await withRetry("getToDiscussPending", () => client.databases.query({
            database_id: NOTION_TO_DISCUSS_DB_ID,
            filter: {
                property: "Estado",
                select: { equals: "Pendente" },
            },
            start_cursor: cursor,
        }));
        for (const row of res.results) {
            if (!("properties" in row))
                continue;
            const props = row.properties;
            const adicionadoPor = readSelectName(props["Adicionado por"]);
            if (adicionadoPor !== "Madalena" &&
                adicionadoPor !== "Mafalda" &&
                adicionadoPor !== "Beatriz") {
                continue;
            }
            const urgenciaName = readSelectName(props["Urgência"]);
            const urgencia = urgenciaName === "Próxima reunião" ||
                urgenciaName === "Decisão offline" ||
                urgenciaName === "Urgente"
                ? urgenciaName
                : "Próxima reunião";
            const estadoName = readSelectName(props["Estado"]);
            const estado = estadoName === "Pendente" ||
                estadoName === "Discutido" ||
                estadoName === "Arquivado"
                ? estadoName
                : "Pendente";
            const deadline = readDateStart(props["Deadline"]) ?? undefined;
            rows.push({
                id: row.id,
                tema: readPlainText(props["Tema"]),
                adicionadoPor,
                urgencia,
                area: (readSelectName(props["Área"]) ?? "Outro"),
                estado,
                data: "",
                resolucao: readPlainText(props["Resolução"]),
                ...(deadline ? { deadline } : {}),
            });
        }
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    log.debug("notion.to_discuss_pending_fetched", { count: rows.length });
    return rows;
}
async function setToDiscussResolved(id, resolucao) {
    if (!NOTION_TO_DISCUSS_DB_ID) {
        throw new Error("NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled");
    }
    await withRetry("setToDiscussResolved", () => client.pages.update({
        page_id: id,
        properties: {
            Estado: { select: { name: "Discutido" } },
            "Resolução": richText(resolucao),
        },
    }));
    log.info("notion.to_discuss_resolved", { id });
}
async function createDecision(d, originalMsg) {
    if (!NOTION_DECISIONS_DB_ID) {
        throw new Error("NOTION_DECISIONS_DB_ID not set — Phase 5 decision features disabled");
    }
    const properties = {
        Decisão: { title: [{ text: { content: d.decisao } }] },
        Área: { select: { name: d.area } },
        "Tomada por": {
            multi_select: d.tomadaPor.map((name) => ({ name })),
        },
        Estado: { select: { name: d.estado } },
        Origem: richText(originalMsg),
    };
    if (d.notas) {
        properties["Notas"] = richText(d.notas);
    }
    const page = await withRetry("createDecision", () => client.pages.create({
        parent: { database_id: NOTION_DECISIONS_DB_ID },
        properties: properties,
    }));
    log.info("notion.decision_created", { id: page.id, area: d.area });
    return page.id;
}
async function getRecentDecisions(n) {
    if (!NOTION_DECISIONS_DB_ID) {
        throw new Error("NOTION_DECISIONS_DB_ID not set — Phase 5 decision features disabled");
    }
    const res = await withRetry("getRecentDecisions", () => client.databases.query({
        database_id: NOTION_DECISIONS_DB_ID,
        sorts: [{ property: "Data", direction: "descending" }],
        page_size: Math.min(Math.max(n, 1), 100),
    }));
    const rows = [];
    for (const row of res.results) {
        if (!("properties" in row))
            continue;
        const props = row.properties;
        const tomadaPorNames = readMultiSelectNames(props["Tomada por"]).filter((name) => name === "Madalena" || name === "Mafalda" || name === "Beatriz");
        const estadoName = readSelectName(props["Estado"]);
        const estado = estadoName === "Implementada"
            ? "Implementada"
            : "Pendente implementação";
        rows.push({
            id: row.id,
            decisao: readPlainText(props["Decisão"]),
            area: (readSelectName(props["Área"]) ?? "Outro"),
            tomadaPor: tomadaPorNames,
            data: readDateStart(props["Data"]),
            estado,
            notas: readPlainText(props["Notas"]),
        });
    }
    log.debug("notion.recent_decisions_fetched", { count: rows.length });
    return rows;
}
async function setTaskDependency(blockedId, prerequisiteId) {
    await withRetry("setTaskDependency", () => client.pages.update({
        page_id: blockedId,
        properties: {
            "Depende de": { relation: [{ id: prerequisiteId }] },
        },
    }));
    log.info("notion.dependency_set", { blockedId, prerequisiteId });
}
async function getDependentTasks(prerequisiteId) {
    if (!NOTION_BACKLOG_DB_ID)
        return [];
    const res = await withRetry("getDependentTasks", () => client.databases.query({
        database_id: NOTION_BACKLOG_DB_ID,
        filter: {
            and: [
                { property: "Depende de", relation: { contains: prerequisiteId } },
                { property: "Status", select: { equals: "Bloqueado" } },
            ],
        },
    }));
    const tasks = [];
    for (const row of res.results) {
        if (!("properties" in row))
            continue;
        tasks.push(rowToOpenTask({
            id: row.id,
            properties: row.properties,
        }));
    }
    log.debug("notion.dependents_fetched", {
        prerequisiteId,
        count: tasks.length,
    });
    return tasks;
}
// silence unused-helper warning for readDateTime (kept for callers)
void readDateTime;
// ============================================================
// Feature D — Create entities (project / event / partner / influencer)
// ============================================================
function toggleHeading(title) {
    return {
        type: "heading_2",
        heading_2: {
            rich_text: [{ type: "text", text: { content: title } }],
            is_toggleable: true,
        },
    };
}
async function createProject(nome, owner, originalMsg) {
    if (!NOTION_PROJECTS_DB_ID) {
        throw new Error("NOTION_PROJECTS_DB_ID not set");
    }
    const page = await withRetry("createProject", () => client.pages.create({
        parent: { database_id: NOTION_PROJECTS_DB_ID },
        properties: {
            "Name": { title: [{ text: { content: nome } }] },
            Owner: { multi_select: [{ name: owner }] },
            Origem: richText(originalMsg),
        },
    }));
    await withRetry("createProject.sections", () => client.blocks.children.append({
        block_id: page.id,
        children: [
            toggleHeading("📋 Contexto"),
            toggleHeading("🎯 Objetivos"),
            toggleHeading("✅ Tasks"),
            toggleHeading("💬 To Discuss"),
            toggleHeading("📋 Decisions"),
            toggleHeading("📎 Recursos"),
            toggleHeading("📓 Notas"),
        ],
    }));
    log.info("notion.project_created", { pageId: page.id, nome, owner });
    return page.id;
}
async function createEvent(nome, owner, originalMsg) {
    if (!NOTION_EVENT_DB_ID) {
        throw new Error("NOTION_EVENT_DB_ID not set");
    }
    const page = await withRetry("createEvent", () => client.pages.create({
        parent: { database_id: NOTION_EVENT_DB_ID },
        properties: {
            "Name": { title: [{ text: { content: nome } }] },
            Owner: { multi_select: [{ name: owner }] },
            Status: { select: { name: "Ideia" } },
            Origem: richText(originalMsg),
        },
    }));
    await withRetry("createEvent.sections", () => client.blocks.children.append({
        block_id: page.id,
        children: [
            toggleHeading("📋 Descrição"),
            toggleHeading("📅 Logística"),
            toggleHeading("✅ Tasks"),
            toggleHeading("💬 To Discuss"),
            toggleHeading("📋 Decisions"),
            toggleHeading("📢 Comunicação"),
            toggleHeading("📊 Resultados"),
        ],
    }));
    log.info("notion.event_created", { pageId: page.id, nome, owner });
    return page.id;
}
async function createPartner(nome, owner, originalMsg) {
    if (!NOTION_PARTNER_DB_ID) {
        throw new Error("NOTION_PARTNER_DB_ID not set");
    }
    const page = await withRetry("createPartner", () => client.pages.create({
        parent: { database_id: NOTION_PARTNER_DB_ID },
        properties: {
            "Name": { title: [{ text: { content: nome } }] },
            Owner: { select: { name: owner } },
            Status: { select: { name: "A contactar" } },
            Origem: richText(originalMsg),
        },
    }));
    await withRetry("createPartner.sections", () => client.blocks.children.append({
        block_id: page.id,
        children: [
            toggleHeading("🤝 Sobre o parceiro"),
            toggleHeading("💼 Deal e proposta"),
            toggleHeading("✅ Tasks"),
            toggleHeading("💬 To Discuss"),
            toggleHeading("📋 Decisions"),
            toggleHeading("📞 Contactos"),
            toggleHeading("📎 Contratos"),
        ],
    }));
    log.info("notion.partner_created", { pageId: page.id, nome, owner });
    return page.id;
}
async function createInfluencer(nome, owner) {
    if (!NOTION_INFLUENCER_DB_ID) {
        throw new Error("NOTION_INFLUENCER_DB_ID not set");
    }
    const page = await withRetry("createInfluencer", () => client.pages.create({
        parent: { database_id: NOTION_INFLUENCER_DB_ID },
        properties: {
            "Name": { title: [{ text: { content: nome } }] },
            Owner: { select: { name: owner } },
            Status: { select: { name: "A contactar" } },
        },
    }));
    await withRetry("createInfluencer.sections", () => client.blocks.children.append({
        block_id: page.id,
        children: [
            toggleHeading("👤 Perfil e stats"),
            toggleHeading("🤝 Relação e histórico"),
            toggleHeading("📸 Conteúdo e shoots"),
            toggleHeading("✅ Tasks"),
            toggleHeading("💬 To Discuss"),
            toggleHeading("📋 Decisions"),
            toggleHeading("📎 Briefings"),
        ],
    }));
    log.info("notion.influencer_created", { pageId: page.id, nome, owner });
    return page.id;
}
// ----- Page section editing -----
function normalizeSectionName(text) {
    return text
        .replace(/\p{Emoji}/gu, "")
        .replace(/[^\wàáâãéêíóôõúüç\s]/gi, "")
        .toLowerCase()
        .trim();
}
const URL_RE = /^https?:\/\/\S+$/i;
function contentToBlocks(content) {
    return content
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim())
        .map((line) => {
        const t = line.trim();
        if (URL_RE.test(t)) {
            return { type: "bookmark", bookmark: { url: t } };
        }
        if (t.startsWith("- ")) {
            return {
                type: "bulleted_list_item",
                bulleted_list_item: { rich_text: [{ type: "text", text: { content: t.slice(2).trim() } }] },
            };
        }
        return {
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: t } }] },
        };
    });
}
async function findPageInDb(db, name) {
    const config = RECORD_DB_CONFIGS[db];
    if (!config)
        return null;
    const dbId = config.dbId();
    if (!dbId)
        return null;
    return findRecordByTitle(dbId, config.titleProp, name);
}
async function getOrCreateToggleId(pageId, sectionName) {
    const queryNorm = normalizeSectionName(sectionName);
    const listRes = await withRetry("listPageBlocks", () => client.blocks.children.list({ block_id: pageId, page_size: 100 }));
    for (const block of listRes.results) {
        if (!("type" in block))
            continue;
        const b = block;
        if (!["heading_1", "heading_2", "heading_3"].includes(b.type))
            continue;
        const hData = b[b.type];
        if (!hData.is_toggleable)
            continue;
        const blockNorm = normalizeSectionName((hData.rich_text ?? []).map((rt) => rt.plain_text ?? "").join(""));
        if (blockNorm.includes(queryNorm) || queryNorm.includes(blockNorm)) {
            return b.id;
        }
    }
    const label = /^\p{Emoji}/u.test(sectionName.trim()) ? sectionName : `📌 ${sectionName}`;
    const createRes = await withRetry("createToggle", () => client.blocks.children.append({
        block_id: pageId,
        children: [toggleHeading(label)],
    }));
    return createRes.results[0].id;
}
async function appendToPageSection(pageId, content, section) {
    const blocks = contentToBlocks(content);
    if (!blocks.length)
        return;
    const children = blocks;
    const targetId = section ? await getOrCreateToggleId(pageId, section) : pageId;
    await withRetry("appendToSection", () => client.blocks.children.append({ block_id: targetId, children }));
    log.info("notion.page_content_added", { pageId, section: section ?? "root" });
}
const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
async function uploadAndAttachFile(pageId, fileName, mimeType, fileBuffer, section) {
    // Step 1 — create file upload entry
    const createRes = await fetch(`${NOTION_API_BASE}/file_uploads`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "single_part" }),
    });
    if (!createRes.ok) {
        const body = await createRes.text();
        throw new Error(`notion: file_upload create ${createRes.status}: ${body}`);
    }
    const { id: uploadId, upload_url: uploadUrl } = await createRes.json();
    // Step 2 — upload file data
    const form = new FormData();
    form.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);
    const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${NOTION_API_KEY}`,
            "Notion-Version": NOTION_VERSION,
        },
        body: form,
    });
    if (!uploadRes.ok) {
        const body = await uploadRes.text();
        throw new Error(`notion: file_upload PUT ${uploadRes.status}: ${body}`);
    }
    // Step 3 — append file block
    const fileBlock = {
        type: "file",
        file: {
            type: "file_upload",
            file_upload: { id: uploadId },
            name: fileName,
        },
    };
    const targetId = section ? await getOrCreateToggleId(pageId, section) : pageId;
    await withRetry("appendFile", () => client.blocks.children.append({
        block_id: targetId,
        children: [fileBlock],
    }));
    log.info("notion.file_attached", { pageId, fileName, section });
}
async function addToList(item, lista, adicionadoPor, originalMsg) {
    if (!NOTION_LISTS_DB_ID)
        throw new Error("NOTION_LISTS_DB_ID not set");
    const page = await withRetry("addToList", () => client.pages.create({
        parent: { database_id: NOTION_LISTS_DB_ID },
        properties: {
            Item: { title: [{ text: { content: item.slice(0, 100) } }] },
            Lista: { select: { name: lista } },
            Fechada: { checkbox: false },
            "Adicionado por": { select: { name: adicionadoPor } },
            Origem: richText(originalMsg),
        },
    }));
    log.info("notion.list_item_added", { item, lista, adicionadoPor });
    return page.id;
}
async function checkListItem(itemTitle, lista) {
    if (!NOTION_LISTS_DB_ID)
        throw new Error("NOTION_LISTS_DB_ID not set");
    const res = await withRetry("checkListItem.query", () => client.databases.query({
        database_id: NOTION_LISTS_DB_ID,
        filter: {
            and: [
                { property: "Lista", select: { equals: lista } },
                { property: "Fechada", checkbox: { equals: false } },
            ],
        },
        page_size: 50,
    }));
    // Best title match
    let bestId = null;
    let bestScore = 0;
    const q = itemTitle.toLowerCase();
    for (const row of res.results) {
        const props = row.properties;
        const title = readPlainText(props["Item"]).toLowerCase();
        const exact = title === q ? 1 : 0;
        const includes = title.includes(q) || q.includes(title) ? 0.8 : 0;
        const wa = (() => {
            const wa2 = new Set(q.split(/\s+/).filter(Boolean));
            const wb = new Set(title.split(/\s+/).filter(Boolean));
            if (!wa2.size || !wb.size)
                return 0;
            let overlap = 0;
            for (const w of wa2)
                if (wb.has(w))
                    overlap++;
            return overlap / Math.max(wa2.size, wb.size);
        })();
        const score = exact || includes || wa;
        if (score > bestScore) {
            bestScore = score;
            bestId = row.id;
        }
    }
    if (!bestId || bestScore === 0)
        return null;
    await withRetry("checkListItem.update", () => client.pages.update({ page_id: bestId, properties: { Fechada: { checkbox: true } } }));
    log.info("notion.list_item_checked", { itemTitle, lista, pageId: bestId });
    return bestId;
}
async function getList(lista) {
    if (!NOTION_LISTS_DB_ID)
        return [];
    const filter = lista
        ? { property: "Lista", select: { equals: lista } }
        : undefined;
    const res = await withRetry("getList", () => client.databases.query({
        database_id: NOTION_LISTS_DB_ID,
        ...(filter ? { filter } : {}),
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
    }));
    return res.results.map((row) => {
        const props = row.properties;
        const feito = props["Fechada"] &&
            typeof props["Fechada"] === "object" &&
            "checkbox" in props["Fechada"]
            ? props["Fechada"].checkbox
            : false;
        return {
            id: row.id,
            item: readPlainText(props["Item"]),
            lista: readSelectName(props["Lista"]) ?? "",
            feito,
            adicionadoPor: readSelectName(props["Adicionado por"]) ?? "",
        };
    });
}
// Named exports so callers can use either `import * as notion` or `import { notion }`.
export { createTask, updateTask, getOpenTasks, invalidateOpenTasksCache, archivePage, 
// Phase 2
getOpenTasksFor, getWeeklyPriorities, setWeeklyPriority, getCompletedSince, getOverdueTasks, setFounderFocus, getFounderFocusForWeek, 
// Phase 3
getPartnersStale, getInfluencersStale, getContentCalendarAlerts, getContentCalendarRows, createContentCalendarEntry, createReminder, getDueReminders, markReminderSent, 
// Phase 5
createToDiscuss, getToDiscussPending, setToDiscussResolved, createDecision, getRecentDecisions, 
// Phase 1 redesign — Studio Log
createLogEntry, 
// Dependencies
setTaskDependency, getDependentTasks, 
// Feature D — entities
createProject, createEvent, createPartner, createInfluencer, 
// Feature E — entity lookup
findEntityByName, 
// Lists
addToList, checkListItem, getList, 
// Generic record update
updateRecord, 
// Page section editing
findPageInDb, appendToPageSection, uploadAndAttachFile, };
export const notion = {
    createTask,
    updateTask,
    getOpenTasks,
    invalidateOpenTasksCache,
    archivePage,
    // Phase 2
    getOpenTasksFor,
    getWeeklyPriorities,
    setWeeklyPriority,
    getCompletedSince,
    getOverdueTasks,
    setFounderFocus,
    getFounderFocusForWeek,
    // Phase 3
    getPartnersStale,
    getInfluencersStale,
    getContentCalendarAlerts,
    getContentCalendarRows,
    createContentCalendarEntry,
    createReminder,
    getDueReminders,
    markReminderSent,
    // Phase 5
    createToDiscuss,
    getToDiscussPending,
    setToDiscussResolved,
    createDecision,
    getRecentDecisions,
    // Phase 1 redesign — Studio Log
    createLogEntry,
    // Dependencies
    setTaskDependency,
    getDependentTasks,
    // Feature D — entities
    createProject,
    createEvent,
    createPartner,
    createInfluencer,
    // Feature E — entity lookup
    findEntityByName,
    // Lists
    addToList,
    checkListItem,
    getList,
    // Generic record update
    updateRecord,
    // Page section editing
    findPageInDb,
    appendToPageSection,
    uploadAndAttachFile,
};
