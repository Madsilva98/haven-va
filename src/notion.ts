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
import { isValidRecurrence } from "./types.js";
import type {
  EditableField,
  EntityKind,
  EntityRef,
  FounderName,
  NewTaskExtraction,
  OpenTask,
  OwnerValue,
  Priority,
  Status,
  Area,
  FounderFocusEntry,
  PartnerRow,
  PartnerCategory,
  PartnerStatus,
  InfluencerRow,
  InfluencerStatus,
  ReminderRecurrence,
  ReminderRow,
  ToDiscussRow,
  ToDiscussUrgency,
  ToDiscussState,
  DecisionRow,
} from "./types.js";
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
const NOTION_CONTENT_CALENDAR_DB_ID =
  process.env.NOTION_CONTENT_CALENDAR_DB_ID;
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

function isRetriable(err: unknown): boolean {
  if (err instanceof APIResponseError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false;
  }
  // Network or unknown errors → retry once
  return true;
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
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
      const delay = RETRY_DELAYS_MS[attempt]!;
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
let openTasksCache: { value: OpenTask[]; expiresAt: number } | null = null;

const WEEKLY_PRIORITIES_TTL_MS = 60 * 1000;
const OVERDUE_TTL_MS = 60 * 1000;
let weeklyPrioritiesCache: {
  week: string;
  value: OpenTask[];
  expiresAt: number;
} | null = null;
let overdueCache: { value: OpenTask[]; expiresAt: number } | null = null;

function invalidateOpenTasksCache(): void {
  openTasksCache = null;
  weeklyPrioritiesCache = null;
  overdueCache = null;
}

// ----- property mapping -----

const FIELD_TO_PROPERTY: Record<EditableField, string> = {
  status: "Status",
  owner: "Owner",
  deadline: "Deadline",
  prioridade: "Prioridade",
  area: "Área",
  title: "Título",
};

// ----- helpers -----

function richText(text: string): { rich_text: Array<{ text: { content: string } }> } {
  // Notion limits rich_text content to 2000 chars per chunk.
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push(text.slice(i, i + 2000));
  }
  return {
    rich_text: chunks.map((content) => ({ text: { content } })),
  };
}

function readPlainText(prop: unknown): string {
  if (
    prop &&
    typeof prop === "object" &&
    "rich_text" in prop &&
    Array.isArray((prop as { rich_text: unknown }).rich_text)
  ) {
    return ((prop as { rich_text: Array<{ plain_text?: string }> }).rich_text)
      .map((r) => r.plain_text ?? "")
      .join("");
  }
  if (
    prop &&
    typeof prop === "object" &&
    "title" in prop &&
    Array.isArray((prop as { title: unknown }).title)
  ) {
    return ((prop as { title: Array<{ plain_text?: string }> }).title)
      .map((r) => r.plain_text ?? "")
      .join("");
  }
  return "";
}

function readSelectName(prop: unknown): string | null {
  if (
    prop &&
    typeof prop === "object" &&
    "select" in prop &&
    (prop as { select: unknown }).select &&
    typeof (prop as { select: { name?: string } }).select === "object"
  ) {
    return (prop as { select: { name?: string } }).select.name ?? null;
  }
  return null;
}

function readMultiSelectFirst(prop: unknown): string | null {
  if (
    prop &&
    typeof prop === "object" &&
    "multi_select" in prop &&
    Array.isArray((prop as { multi_select: unknown }).multi_select)
  ) {
    const first = (prop as { multi_select: Array<{ name?: string }> }).multi_select[0];
    return first?.name ?? null;
  }
  return null;
}

function readStatusName(prop: unknown): string | null {
  if (
    prop &&
    typeof prop === "object" &&
    "status" in prop &&
    (prop as { status: unknown }).status &&
    typeof (prop as { status: { name?: string } }).status === "object"
  ) {
    return (prop as { status: { name?: string } }).status.name ?? null;
  }
  return null;
}

function readDateStart(prop: unknown): string | null {
  if (
    prop &&
    typeof prop === "object" &&
    "date" in prop &&
    (prop as { date: unknown }).date &&
    typeof (prop as { date: { start?: string } }).date === "object"
  ) {
    return (prop as { date: { start?: string } }).date.start ?? null;
  }
  return null;
}

function readCheckbox(prop: unknown): boolean {
  if (
    prop &&
    typeof prop === "object" &&
    "checkbox" in prop &&
    typeof (prop as { checkbox: unknown }).checkbox === "boolean"
  ) {
    return (prop as { checkbox: boolean }).checkbox;
  }
  return false;
}

function readMultiSelectNames(prop: unknown): string[] {
  if (
    prop &&
    typeof prop === "object" &&
    "multi_select" in prop &&
    Array.isArray((prop as { multi_select: unknown }).multi_select)
  ) {
    return (prop as { multi_select: Array<{ name?: string }> }).multi_select
      .map((m) => m.name ?? "")
      .filter((n) => n.length > 0);
  }
  return [];
}

function readUrl(prop: unknown): string | null {
  if (
    prop &&
    typeof prop === "object" &&
    "url" in prop &&
    typeof (prop as { url: unknown }).url === "string"
  ) {
    return (prop as { url: string }).url;
  }
  return null;
}

function readDateTime(prop: unknown): string | null {
  // Same as readDateStart but kept for clarity
  return readDateStart(prop);
}

function readFormulaString(prop: unknown): string | null {
  if (
    prop &&
    typeof prop === "object" &&
    "formula" in prop &&
    (prop as { formula: unknown }).formula &&
    typeof (prop as { formula: { string?: string } }).formula === "object"
  ) {
    return (prop as { formula: { string?: string } }).formula.string ?? null;
  }
  return null;
}

function buildEditPatch(field: EditableField, newValue: string): Record<string, unknown> {
  const property = FIELD_TO_PROPERTY[field];
  switch (field) {
    case "status":
      return { [property]: { status: { name: newValue } } };
    case "owner":
      return { [property]: { select: { name: newValue } } };
    case "prioridade":
    case "area":
      return { [property]: { select: { name: newValue } } };
    case "deadline":
      return newValue === "none"
        ? { [property]: { date: null } }
        : { [property]: { date: { start: newValue } } };
    case "title":
      return { [property]: { title: [{ text: { content: newValue } }] } };
  }
}

// ----- entity relation helpers -----

const ENTITY_KIND_TO_FIELD: Record<EntityKind, string> = {
  projeto: "Projects",
  evento: "Events Pipeline",
  parceria: "Partner Pipeline",
  influencer: "Influencer Pipeline",
};

async function findEntityByName(kind: EntityKind, nome: string): Promise<string | null> {
  const dbId =
    kind === "projeto" ? NOTION_PROJECTS_DB_ID
    : kind === "evento" ? NOTION_EVENT_DB_ID
    : kind === "parceria" ? NOTION_PARTNER_DB_ID
    : NOTION_INFLUENCER_DB_ID;
  if (!dbId) return null;
  try {
    const res = await withRetry("findEntityByName", () =>
      client.databases.query({
        database_id: dbId,
        filter: { property: "Name", title: { contains: nome } },
        page_size: 1,
      }),
    );
    return res.results[0]?.id ?? null;
  } catch (err) {
    log.warn("notion.find_entity_failed", { kind, nome, err: String(err) });
    return null;
  }
}

async function entityRelationProps(entityRef?: EntityRef): Promise<Record<string, unknown>> {
  if (!entityRef) return {};
  const pageId = await findEntityByName(entityRef.kind, entityRef.nome);
  const field = ENTITY_KIND_TO_FIELD[entityRef.kind];
  log.info("notion.entity_relation_resolved", { kind: entityRef.kind, nome: entityRef.nome, pageId, field });
  if (!pageId) return {};
  return { [field]: { relation: [{ id: pageId }] } };
}

// ----- methods -----

async function createTask(
  extraction: NewTaskExtraction,
  priority: Priority,
  originalMsg: string,
  sender: FounderName,
  entityRef?: EntityRef,
  deadline?: string,
): Promise<string> {
  const relProps = await entityRelationProps(entityRef);

  const props: Record<string, unknown> = {
    "Título": { title: [{ text: { content: extraction.title } }] },
    Owner: { select: { name: extraction.owner } },
    "Área": { select: { name: extraction.area } },
    Prioridade: { select: { name: priority } },
    Status: { status: { name: "A fazer" satisfies Status } },
    Origem: richText(originalMsg),
    ...relProps,
  };
  if (deadline) props["Deadline"] = { date: { start: deadline } };
  if (priority === "Alta") props["Prioridade semanal"] = { checkbox: true };

  const page = await withRetry("createTask", () =>
    client.pages.create({
      parent: { database_id: NOTION_BACKLOG_DB_ID! },
      properties: props as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );

  invalidateOpenTasksCache();
  log.info("notion.task_created", {
    pageId: page.id,
    title: extraction.title,
    owner: extraction.owner,
    priority,
  });
  return page.id;
}

async function updateTask(
  pageId: string,
  field: EditableField,
  newValue: string,
): Promise<void> {
  const properties = buildEditPatch(field, newValue) as Record<string, unknown>;
  if (field === "prioridade" && newValue === "Alta") {
    properties["Prioridade semanal"] = { checkbox: true };
  }
  await withRetry("updateTask", () =>
    client.pages.update({
      page_id: pageId,
      properties: properties as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  invalidateOpenTasksCache();
  log.info("notion.task_updated", { pageId, field, newValue });
}

type FieldConfig = {
  notionProp: string;
  type: "select" | "multi_select" | "status" | "date" | "rich_text";
};

const RECORD_DB_CONFIGS: Record<string, {
  dbId: () => string | undefined;
  titleProp: string;
  fields: Record<string, FieldConfig>;
}> = {
  to_discuss: {
    dbId: () => NOTION_TO_DISCUSS_DB_ID,
    titleProp: "Tema",
    fields: {
      urgencia: { notionProp: "Urgência", type: "select" },
      status: { notionProp: "Status", type: "status" },
      area: { notionProp: "Área", type: "select" },
      resolucao: { notionProp: "Resolução", type: "rich_text" },
    },
  },
  decisions: {
    dbId: () => NOTION_DECISIONS_DB_ID,
    titleProp: "Decisão",
    fields: {
      status: { notionProp: "Status", type: "status" },
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
      status: { notionProp: "Status", type: "status" },
      owner: { notionProp: "Owner", type: "select" },
    },
  },
  influencers: {
    dbId: () => NOTION_INFLUENCER_DB_ID,
    titleProp: "Name",
    fields: {
      status: { notionProp: "Status", type: "status" },
      owner: { notionProp: "Owner", type: "select" },
    },
  },
  events: {
    dbId: () => NOTION_EVENT_DB_ID,
    titleProp: "Name",
    fields: {
      status: { notionProp: "Status", type: "status" },
      owner: { notionProp: "Owner", type: "multi_select" },
    },
  },
  projects: {
    dbId: () => NOTION_PROJECTS_DB_ID,
    titleProp: "Name",
    fields: {
      status: { notionProp: "Status", type: "status" },
      owner: { notionProp: "Owner", type: "multi_select" },
    },
  },
};

async function findRecordByTitle(
  dbId: string,
  titleProp: string,
  query: string,
  dbKey?: string,
): Promise<{ id: string; title: string } | null> {
  // Layer 1a: title.contains (fast, exact)
  const res = await withRetry("findRecordByTitle", () =>
    client.databases.query({
      database_id: dbId,
      filter: { property: titleProp, title: { contains: query } },
      page_size: 5,
    }),
  );
  const pages = res.results.filter((r) => "properties" in r) as Array<{
    id: string;
    properties: Record<string, unknown>;
  }>;
  if (pages.length > 0) {
    const firstPage = pages[0]!;
    return { id: firstPage.id, title: readPlainText(firstPage.properties[titleProp]) };
  }

  // Layer 1b: Notion search API (accent/case-insensitive)
  try {
    const searchRes = await withRetry("findRecordByTitle.search", () =>
      client.search({ query, filter: { property: "object", value: "page" }, page_size: 10 }),
    );
    const normalizedDbId = dbId.replace(/-/g, "");
    for (const result of searchRes.results) {
      if (!("parent" in result) || !("properties" in result)) continue;
      const parent = result.parent as { type: string; database_id?: string };
      if (parent.type !== "database_id" || !parent.database_id) continue;
      if (parent.database_id.replace(/-/g, "") !== normalizedDbId) continue;
      const title = readPlainText((result.properties as Record<string, unknown>)[titleProp]);
      return { id: result.id, title };
    }
  } catch (err) {
    log.warn("notion.find_fallback_failed", { query, err: String(err) });
  }

  // Layer 2: word-level multi-search
  const words = significantWords(query);
  if (words.length > 0) {
    const seen = new Set<string>();
    const candidates: { id: string; title: string; score: number }[] = [];
    for (const word of words) {
      try {
        const wRes = await withRetry("findRecordByTitle.word", () =>
          client.databases.query({
            database_id: dbId,
            filter: { property: titleProp, title: { contains: word } },
            page_size: 10,
          }),
        );
        for (const r of wRes.results) {
          if (!("properties" in r) || seen.has(r.id)) continue;
          seen.add(r.id);
          const title = readPlainText((r as { id: string; properties: Record<string, unknown> }).properties[titleProp]);
          candidates.push({ id: r.id, title, score: scoreMatch(title, query) });
        }
      } catch { /* continue */ }
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      return { id: candidates[0]!.id, title: candidates[0]!.title };
    }
  }

  // Layer 3: fetch-all + client-side scoring (small DBs only)
  if (dbKey && SMALL_DBS.has(dbKey)) {
    try {
      const allRes = await withRetry("findRecordByTitle.fetchAll", () =>
        client.databases.query({ database_id: dbId, page_size: 100 }),
      );
      let best: { id: string; title: string; score: number } | null = null;
      for (const r of allRes.results) {
        if (!("properties" in r)) continue;
        const title = readPlainText((r as { id: string; properties: Record<string, unknown> }).properties[titleProp]);
        const score = scoreMatch(title, query);
        if (score > 0 && (!best || score > best.score)) {
          best = { id: r.id, title, score };
        }
      }
      if (best) return { id: best.id, title: best.title };
    } catch (err) {
      log.warn("notion.find_fetchall_failed", { query, err: String(err) });
    }
  }

  return null;
}

async function findBacklogTask(query: string): Promise<{ id: string; title: string } | null> {
  if (!NOTION_BACKLOG_DB_ID) return null;
  return findRecordByTitle(NOTION_BACKLOG_DB_ID, "Título", query, "backlog");
}

interface SearchResult {
  id: string;
  title: string;
  owner?: string;
  status?: string;
  area?: string;
  priority?: string;
  deadline?: string;
}

async function searchRecordsInDb(
  dbId: string,
  titleProp: string,
  query: string,
  mapRow: (row: { id: string; properties: Record<string, unknown> }) => SearchResult,
  dbKey?: string,
): Promise<SearchResult[]> {
  // Layer 1a: title.contains (fast, exact)
  const res = await withRetry("searchRecordsInDb", () =>
    client.databases.query({
      database_id: dbId,
      filter: { property: titleProp, title: { contains: query } },
      page_size: 10,
    }),
  );
  const rows = res.results.filter((r) => "properties" in r) as Array<{ id: string; properties: Record<string, unknown> }>;
  if (rows.length > 0) return rows.map(mapRow);

  // Layer 1b: Notion search (accent/case-insensitive)
  try {
    const searchRes = await withRetry("searchRecordsInDb.search", () =>
      client.search({ query, filter: { property: "object", value: "page" }, page_size: 10 }),
    );
    const normalizedDbId = dbId.replace(/-/g, "");
    const fallback: SearchResult[] = [];
    for (const result of searchRes.results) {
      if (!("parent" in result) || !("properties" in result)) continue;
      const parent = result.parent as { type: string; database_id?: string };
      if (parent.type !== "database_id" || !parent.database_id) continue;
      if (parent.database_id.replace(/-/g, "") !== normalizedDbId) continue;
      fallback.push(mapRow({ id: result.id, properties: result.properties as Record<string, unknown> }));
    }
    if (fallback.length > 0) return fallback;
  } catch (err) {
    log.warn("notion.search_fallback_failed", { query, err: String(err) });
  }

  // Layer 2: word-level multi-search
  const words = significantWords(query);
  if (words.length > 0) {
    const seen = new Set<string>();
    const wordResults: SearchResult[] = [];
    for (const word of words) {
      try {
        const wRes = await withRetry("searchRecordsInDb.word", () =>
          client.databases.query({
            database_id: dbId,
            filter: { property: titleProp, title: { contains: word } },
            page_size: 10,
          }),
        );
        for (const r of wRes.results) {
          if (!("properties" in r) || seen.has(r.id)) continue;
          seen.add(r.id);
          wordResults.push(mapRow({ id: r.id, properties: r.properties as Record<string, unknown> }));
        }
      } catch { /* continue */ }
    }
    if (wordResults.length > 0) {
      return wordResults.sort((a, b) => scoreMatch(b.title, query) - scoreMatch(a.title, query));
    }
  }

  // Layer 3: fetch-all + client-side scoring (small DBs only)
  if (dbKey && SMALL_DBS.has(dbKey)) {
    try {
      const allRes = await withRetry("searchRecordsInDb.fetchAll", () =>
        client.databases.query({ database_id: dbId, page_size: 100 }),
      );
      const scored = allRes.results
        .filter((r) => "properties" in r)
        .map((r) => {
          const row = { id: r.id, properties: r.properties as Record<string, unknown> };
          const result = mapRow(row);
          return { result, score: scoreMatch(result.title, query) };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      return scored.map(({ result }) => result);
    } catch (err) {
      log.warn("notion.fetchall_failed", { query, err: String(err) });
    }
  }

  return [];
}

async function searchRecords(db: string, query: string): Promise<SearchResult[]> {
  if (db === "backlog") {
    if (!NOTION_BACKLOG_DB_ID) return [];
    return searchRecordsInDb(NOTION_BACKLOG_DB_ID, "Título", query, (row) => ({
      id: row.id,
      title: readPlainText(row.properties["Título"]),
      owner: readSelectName(row.properties["Owner"]) ?? "Unassigned",
      status: readStatusName(row.properties["Status"]) ?? "To do",
      area: readSelectName(row.properties["Área"]) ?? undefined,
      priority: readSelectName(row.properties["Prioridade"]) ?? undefined,
      deadline: readDateStart(row.properties["Deadline"]) ?? undefined,
    }), "backlog");
  }

  const config = RECORD_DB_CONFIGS[db];
  if (!config) return [];
  const dbId = config.dbId();
  if (!dbId) return [];

  return searchRecordsInDb(dbId, config.titleProp, query, (row) => {
    const title = readPlainText(row.properties[config.titleProp]);
    const statusFieldConf = Object.values(config.fields).find(
      (f) => f.notionProp === "Status" || f.notionProp === "status",
    );
    const status = statusFieldConf
      ? (readStatusName(row.properties[statusFieldConf.notionProp]) ?? readSelectName(row.properties[statusFieldConf.notionProp]) ?? undefined)
      : undefined;
    return { id: row.id, title, status };
  }, db);
}

async function updateRecord(
  db: string,
  itemTitle: string,
  field: string,
  newValue: string,
): Promise<{ pageId: string; title: string } | null> {
  const config = RECORD_DB_CONFIGS[db];
  if (!config) throw new Error(`Unknown db: ${db}`);
  const dbId = config.dbId();
  if (!dbId) throw new Error(`DB ${db} not configured`);
  const fieldConfig = config.fields[field];
  if (!fieldConfig) throw new Error(`Unknown field '${field}' for db '${db}'`);

  const found = await findRecordByTitle(dbId, config.titleProp, itemTitle, db);
  if (!found) return null;

  let propValue: unknown;
  switch (fieldConfig.type) {
    case "select": propValue = { select: { name: newValue } }; break;
    case "multi_select": propValue = { multi_select: [{ name: newValue }] }; break;
    case "status": propValue = { status: { name: newValue } }; break;
    case "date": propValue = { date: { start: newValue } }; break;
    case "rich_text": propValue = richText(newValue); break;
  }

  await withRetry("updateRecord", () =>
    client.pages.update({
      page_id: found.id,
      properties: {
        [fieldConfig.notionProp]: propValue,
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.info("notion.record_updated", { db, title: found.title, field, newValue });
  return { pageId: found.id, title: found.title };
}

async function archivePage(pageId: string): Promise<void> {
  await withRetry("archivePage", () =>
    client.pages.update({ page_id: pageId, archived: true }),
  );
  invalidateOpenTasksCache();
  log.info("notion.page_archived", { pageId });
}

async function getOpenTasks(): Promise<OpenTask[]> {
  const now = Date.now();
  if (openTasksCache && openTasksCache.expiresAt > now) {
    return openTasksCache.value;
  }

  const tasks: OpenTask[] = [];
  let cursor: string | undefined;

  do {
    const res = await withRetry("getOpenTasks", () =>
      client.databases.query({
        database_id: NOTION_BACKLOG_DB_ID!,
        filter: {
          and: [
            { property: "Status", status: { does_not_equal: "Feito" } },
            { property: "Status", status: { does_not_equal: "Cancelado" } },
          ],
        },
        start_cursor: cursor,
      }),
    );

    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, unknown>;
      const title = readPlainText(props["Título"]);
      const owner = (readSelectName(props["Owner"]) ?? "Unassigned") as OwnerValue;
      const area = (readSelectName(props["Área"]) ?? "Outro") as Area;
      const priorityName = readSelectName(props["Prioridade"]);
      const priority =
        priorityName === "Alta" || priorityName === "Média" || priorityName === "Baixa"
          ? (priorityName as Priority)
          : null;
      const deadline = readDateStart(props["Deadline"]);
      const statusName = readStatusName(props["Status"]) ?? "A fazer";
      const status = statusName as Status;

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

function rowToOpenTask(row: { id: string; properties: Record<string, unknown> }): OpenTask {
  const props = row.properties;
  const title = readPlainText(props["Título"]);
  const owner = (readSelectName(props["Owner"]) ?? "Unassigned") as OwnerValue;
  const area = (readSelectName(props["Área"]) ?? "Outro") as Area;
  const priorityName = readSelectName(props["Prioridade"]);
  const priority =
    priorityName === "1. Alta" || priorityName === "2. Média" || priorityName === "3. Baixa"
      ? (priorityName as Priority)
      : null;
  const deadline = readDateStart(props["Deadline"]);
  const statusName = readStatusName(props["Status"]) ?? "To do";
  return {
    id: row.id,
    title,
    owner,
    area,
    priority,
    deadline,
    status: statusName as Status,
  };
}

async function getOpenTasksFor(owner: FounderName): Promise<OpenTask[]> {
  const all = await getOpenTasks();
  return all.filter((t) => t.owner === owner);
}

async function getWeeklyPriorities(week: string): Promise<OpenTask[]> {
  const now = Date.now();
  if (
    weeklyPrioritiesCache &&
    weeklyPrioritiesCache.week === week &&
    weeklyPrioritiesCache.expiresAt > now
  ) {
    return weeklyPrioritiesCache.value;
  }

  const tasks: OpenTask[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getWeeklyPriorities", () =>
      client.databases.query({
        database_id: NOTION_BACKLOG_DB_ID!,
        filter: {
          and: [
            { property: "Prioridade semanal", checkbox: { equals: true } },
            { property: "Status", status: { does_not_equal: "Feito" } },
            { property: "Status", status: { does_not_equal: "Cancelado" } },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      // Match by Semana formula string
      const props = row.properties as Record<string, unknown>;
      const semana = readFormulaString(props["Semana"]);
      if (semana !== null && semana !== week) continue;
      tasks.push(
        rowToOpenTask({ id: row.id, properties: props }),
      );
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

async function setWeeklyPriority(taskId: string, value: boolean): Promise<void> {
  await withRetry("setWeeklyPriority", () =>
    client.pages.update({
      page_id: taskId,
      properties: {
        "Prioridade semanal": { checkbox: value },
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  weeklyPrioritiesCache = null;
  log.info("notion.weekly_priority_set", { taskId, value });
}

async function getCompletedSince(date: string): Promise<OpenTask[]> {
  const tasks: OpenTask[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getCompletedSince", () =>
      client.databases.query({
        database_id: NOTION_BACKLOG_DB_ID!,
        filter: {
          and: [
            { property: "Status", status: { equals: "Feito" } },
            {
              timestamp: "last_edited_time",
              last_edited_time: { on_or_after: date },
            },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      tasks.push(
        rowToOpenTask({
          id: row.id,
          properties: row.properties as Record<string, unknown>,
        }),
      );
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  log.debug("notion.completed_since_fetched", { since: date, count: tasks.length });
  return tasks;
}

async function getOverdueTasks(): Promise<OpenTask[]> {
  const now = Date.now();
  if (overdueCache && overdueCache.expiresAt > now) {
    return overdueCache.value;
  }
  const today = new Date().toISOString().slice(0, 10);
  const tasks: OpenTask[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getOverdueTasks", () =>
      client.databases.query({
        database_id: NOTION_BACKLOG_DB_ID!,
        filter: {
          and: [
            { property: "Deadline", date: { before: today } },
            { property: "Status", status: { does_not_equal: "Feito" } },
            { property: "Status", status: { does_not_equal: "Cancelado" } },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      tasks.push(
        rowToOpenTask({
          id: row.id,
          properties: row.properties as Record<string, unknown>,
        }),
      );
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  overdueCache = { value: tasks, expiresAt: now + OVERDUE_TTL_MS };
  log.debug("notion.overdue_fetched", { count: tasks.length });
  return tasks;
}

async function setFounderFocus(entry: FounderFocusEntry): Promise<void> {
  if (!NOTION_FOUNDER_FOCUS_DB_ID) {
    throw new Error("NOTION_FOUNDER_FOCUS_DB_ID not set");
  }
  // Always create — latest entry per founder is the active focus.
  await withRetry("setFounderFocus", () =>
    client.pages.create({
      parent: { database_id: NOTION_FOUNDER_FOCUS_DB_ID! },
      properties: {
        Name: { title: [{ text: { content: entry.focoOperacional.slice(0, 80) } }] },
        Founder: { select: { name: entry.founder } },
        "Foco operacional": richText(entry.focoOperacional),
        Ativo: { checkbox: true },
      } as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.info("notion.founder_focus_created", { founder: entry.founder, semana: entry.semana });
}

async function getFounderFocusForWeek(week: string): Promise<FounderFocusEntry[]> {
  if (!NOTION_FOUNDER_FOCUS_DB_ID) return [];
  const res = await withRetry("getFounderFocusForWeek", () =>
    client.databases.query({
      database_id: NOTION_FOUNDER_FOCUS_DB_ID!,
      filter: { property: "Semana", formula: { string: { equals: week } } },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    }),
  );
  // Latest entry per founder is the active focus.
  const seen = new Set<string>();
  const entries: FounderFocusEntry[] = [];
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    const props = row.properties as Record<string, unknown>;
    const founderName = readSelectName(props["Founder"]);
    if (founderName !== "Madalena" && founderName !== "Mafalda" && founderName !== "Beatriz") continue;
    if (seen.has(founderName)) continue;
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

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function getPartnersStale(
  category: "no_response" | "no_progress",
): Promise<PartnerRow[]> {
  if (!NOTION_PARTNER_DB_ID) {
    throw new Error(
      "NOTION_PARTNER_DB_ID not set — Phase 3 partner features disabled",
    );
  }

  const cutoff =
    category === "no_response"
      ? daysAgo(PARTNER_NO_RESPONSE_DAYS)
      : daysAgo(PARTNER_NO_PROGRESS_DAYS);

  const statusFilter =
    category === "no_response"
      ? {
          or: [
            { property: "Status", status: { equals: "Contactado" } },
            { property: "Status", status: { equals: "A aguardar resposta" } },
          ],
        }
      : { property: "Status", status: { equals: "Em negociação" } };

  const rows: PartnerRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getPartnersStale", () =>
      client.databases.query({
        database_id: NOTION_PARTNER_DB_ID,
        filter: {
          and: [
            statusFilter,
            { property: "Último contacto", date: { before: cutoff } },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, unknown>;
      const cat = readSelectName(props["Categoria"]) as PartnerCategory | null;
      const status = readStatusName(props["Status"]) as PartnerStatus | null;
      rows.push({
        id: row.id,
        nome: readPlainText(props["Name"]),
        categoria: cat,
        owner: (readSelectName(props["Owner"]) ?? "Unassigned") as OwnerValue,
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

async function getInfluencersStale(
  category: "no_response" | "no_progress",
): Promise<InfluencerRow[]> {
  if (!NOTION_INFLUENCER_DB_ID) {
    throw new Error(
      "NOTION_INFLUENCER_DB_ID not set — Phase 3 influencer features disabled",
    );
  }

  const cutoff =
    category === "no_response"
      ? daysAgo(INFLUENCER_NO_RESPONSE_DAYS)
      : daysAgo(INFLUENCER_NO_PROGRESS_DAYS);

  // Influencer does not have a literal "A aguardar resposta" status; map
  // "no_response" → Contactado (no reply), "no_progress" → Em conversa stalled.
  const statusFilter =
    category === "no_response"
      ? { property: "Status", status: { equals: "Contactado" } }
      : { property: "Status", status: { equals: "Em conversa" } };

  const rows: InfluencerRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getInfluencersStale", () =>
      client.databases.query({
        database_id: NOTION_INFLUENCER_DB_ID,
        filter: {
          and: [
            statusFilter,
            { property: "Último contacto", date: { before: cutoff } },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, unknown>;
      const status = readStatusName(props["Status"]) as InfluencerStatus | null;
      rows.push({
        id: row.id,
        nome: readPlainText(props["Name"]),
        instagram: readUrl(props["Instagram"]),
        owner: (readSelectName(props["Owner"]) ?? "Unassigned") as OwnerValue,
        status,
        ultimoContacto: readDateStart(props["Último contacto"]),
        proximoPasso: readPlainText(props["Próximo passo"]),
        notas: readPlainText(props["Notas"]),
        origem: readPlainText(props["Origem"]),
      });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  log.debug("notion.influencers_stale_fetched", { category, count: rows.length });
  return rows;
}

async function getContentCalendarAlerts(): Promise<{
  hours_to_publish_unscheduled: unknown[];
  editing_too_long: unknown[];
  ideation_stale: unknown[];
}> {
  const empty = {
    hours_to_publish_unscheduled: [] as unknown[],
    editing_too_long: [] as unknown[],
    ideation_stale: [] as unknown[],
  };
  if (!NOTION_CONTENT_CALENDAR_DB_ID) {
    return empty;
  }
  try {
    const rows: Array<{ id: string; properties: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    do {
      const res = await withRetry("getContentCalendarAlerts", () =>
        client.databases.query({
          database_id: NOTION_CONTENT_CALENDAR_DB_ID,
          start_cursor: cursor,
        }),
      );
      for (const row of res.results) {
        if (!("properties" in row)) continue;
        rows.push({
          id: row.id,
          properties: row.properties as Record<string, unknown>,
        });
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);

    const now = Date.now();
    const hoursToPublishUnscheduled: unknown[] = [];
    const editingTooLong: unknown[] = [];
    const ideationStale: unknown[] = [];

    for (const row of rows) {
      try {
        const props = row.properties;
        // Defensive: try common property names (unknown schema)
        const status =
          readSelectName(props["Status"]) ??
          readStatusName(props["Status"]) ??
          readSelectName(props["status"]);
        const publishDate =
          readDateStart(props["Data publicação"]) ??
          readDateStart(props["Publish date"]) ??
          readDateStart(props["Data"]);
        const lastEdited =
          readDateStart(props["Last edited"]) ??
          readDateStart(props["Atualizado em"]);

        if (publishDate) {
          const ms = new Date(publishDate).getTime() - now;
          const hours = ms / (1000 * 60 * 60);
          if (hours > 0 && hours < 24 && status !== "Agendado") {
            hoursToPublishUnscheduled.push(row);
          }
          if (
            hours > 0 &&
            hours < 48 &&
            (status === "Em edição" || status === "Editing")
          ) {
            editingTooLong.push(row);
          }
        }
        if (status === "Ideação" || status === "Ideation") {
          const reference = lastEdited
            ? new Date(lastEdited).getTime()
            : null;
          if (reference !== null) {
            const ageDays = (now - reference) / (1000 * 60 * 60 * 24);
            if (ageDays > 14) ideationStale.push(row);
          }
        }
      } catch (err) {
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
  } catch (err) {
    log.warn("notion.content_calendar_alerts_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return empty;
  }
}

export interface ContentCalendarRow {
  id: string;
  title: string;
  status: string | null;
  publishDate: string | null;
  platform: string | null;
  owner: string | null;
}

async function getContentCalendarRows(): Promise<ContentCalendarRow[]> {
  if (!NOTION_CONTENT_CALENDAR_DB_ID) return [];
  try {
    const rows: ContentCalendarRow[] = [];
    let cursor: string | undefined;
    do {
      const res = await withRetry("getContentCalendarRows", () =>
        client.databases.query({
          database_id: NOTION_CONTENT_CALENDAR_DB_ID,
          start_cursor: cursor,
        }),
      );
      for (const row of res.results) {
        if (!("properties" in row)) continue;
        const props = row.properties as Record<string, unknown>;
        const title = readPlainText(
          props["Name"] ?? props["Título"] ?? props["Title"] ?? props["name"],
        );
        const status =
          readStatusName(props["status"]) ??
          readSelectName(props["status"]) ??
          readStatusName(props["Status"]) ??
          readSelectName(props["Status"]) ?? null;
        const publishDate =
          readDateStart(props["Posting Haven"]) ??
          readDateStart(props["Data publicação"]) ??
          readDateStart(props["Publish date"]) ??
          readDateStart(props["Data"]) ?? null;
        const adType = readSelectName(props["Ad type"]) ?? null;
        rows.push({ id: row.id, title, status, publishDate, platform: adType, owner: null });
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    return rows;
  } catch (err) {
    log.warn("notion.content_calendar_rows_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function createContentCalendarEntry(params: {
  title: string;
  status?: string;
  publishDate?: string;
  adType?: string;
  originalMsg?: string;
}): Promise<string> {
  if (!NOTION_CONTENT_CALENDAR_DB_ID) {
    throw new Error("notion: NOTION_CONTENT_CALENDAR_DB_ID is not configured");
  }
  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: params.title } }] },
    status: { status: { name: params.status ?? "raw idea" } },
  };
  if (params.publishDate) {
    properties["Posting Haven"] = { date: { start: params.publishDate } };
  }
  if (params.adType) {
    properties["Ad type"] = { select: { name: params.adType } };
  }
  const page = await withRetry("createContentCalendarEntry", () =>
    client.pages.create({
      parent: { database_id: NOTION_CONTENT_CALENDAR_DB_ID! },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.info("notion.content_calendar_entry_created", { title: params.title });
  return page.id;
}

async function createReminder(
  r: Omit<ReminderRow, "id" | "enviado">,
  taskPageId?: string,
): Promise<string> {
  if (!NOTION_REMINDERS_DB_ID) {
    throw new Error(
      "NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled",
    );
  }
  const properties: Record<string, unknown> = {
    Reminder: { title: [{ text: { content: r.texto.slice(0, 80) } }] },
    "Para quem": { multi_select: [{ name: r.paraQuem }] },
    Quando: { date: { start: r.quando } },
    Origem: richText(r.origem),
    Enviado: { checkbox: false },
  };
  if (taskPageId) {
    properties["Da tarefa"] = { relation: [{ id: taskPageId }] };
  }
  if (r.recurrence) {
    properties["Recorrência"] = { select: { name: r.recurrence } };
  }
  const page = await withRetry("createReminder", () =>
    client.pages.create({
      parent: { database_id: NOTION_REMINDERS_DB_ID },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  if (taskPageId) {
    await withRetry("createReminder.linkTask", () =>
      client.pages.update({
        page_id: taskPageId,
        properties: {
          "Com Reminder": { relation: [{ id: page.id }] },
        } as Parameters<typeof client.pages.update>[0]["properties"],
      }),
    );
  }
  log.info("notion.reminder_created", { id: page.id, paraQuem: r.paraQuem });
  return page.id;
}

async function getDueReminders(): Promise<ReminderRow[]> {
  if (!NOTION_REMINDERS_DB_ID) {
    throw new Error(
      "NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled",
    );
  }
  const now = new Date().toISOString();
  const rows: ReminderRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getDueReminders", () =>
      client.databases.query({
        database_id: NOTION_REMINDERS_DB_ID,
        filter: {
          and: [
            { property: "Enviado", checkbox: { equals: false } },
            { property: "Feito",   checkbox: { equals: false } },
            { property: "Quando",  date: { on_or_before: now } },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, unknown>;
      const paraQuem = readMultiSelectFirst(props["Para quem"]);
      if (
        paraQuem !== "Madalena" &&
        paraQuem !== "Mafalda" &&
        paraQuem !== "Beatriz"
      ) {
        continue;
      }
      const recurrenceRaw = readSelectName(props["Recorrência"]);
      let recurrence: ReminderRecurrence | undefined;
      if (recurrenceRaw == null) {
        recurrence = undefined;
      } else if (isValidRecurrence(recurrenceRaw)) {
        recurrence = recurrenceRaw;
      } else {
        log.warn("notion.unknown_recurrence", { id: row.id, value: recurrenceRaw });
        recurrence = undefined;
      }
      rows.push({
        id: row.id,
        texto: readPlainText(props["Reminder"]),
        paraQuem,
        quando: readDateStart(props["Quando"]) ?? "",
        origem: readPlainText(props["Origem"]),
        enviado: readCheckbox(props["Enviado"]),
        feito: readCheckbox(props["Feito"]),
        recurrence,
      });
    }
    cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
  } while (cursor);
  log.debug("notion.due_reminders_fetched", { count: rows.length });
  return rows;
}

async function markReminderSent(id: string): Promise<void> {
  if (!NOTION_REMINDERS_DB_ID) {
    throw new Error(
      "NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled",
    );
  }
  await withRetry("markReminderSent", () =>
    client.pages.update({
      page_id: id,
      properties: {
        Enviado: { checkbox: true },
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.info("notion.reminder_marked_sent", { id });
}

async function cancelReminder(text: string): Promise<string | null> {
  if (!NOTION_REMINDERS_DB_ID) return null;
  const res = await withRetry("cancelReminder", () =>
    client.databases.query({
      database_id: NOTION_REMINDERS_DB_ID,
      filter: {
        and: [
          { property: "Reminder", title: { contains: text } },
          { property: "Enviado",  checkbox: { equals: false } },
          { property: "Feito",    checkbox: { equals: false } },
        ],
      },
      page_size: 1,
    }),
  );
  const row = res.results[0];
  if (!row || !("properties" in row)) return null;
  const props = row.properties as Record<string, unknown>;
  const title = readPlainText(props["Reminder"]);
  await withRetry("cancelReminder.archive", () =>
    client.pages.update({ page_id: row.id, archived: true }),
  );
  log.info("notion.reminder_cancelled", { id: row.id, text: title });
  return title;
}

// ============================================================
// Phase 5 — To Discuss / Decisions
// ============================================================

async function createToDiscuss(
  item: Omit<ToDiscussRow, "id" | "data" | "estado">,
  originalMsg: string,
  entityRef?: EntityRef,
): Promise<string> {
  if (!NOTION_TO_DISCUSS_DB_ID) {
    throw new Error(
      "NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled",
    );
  }
  const relProps = await entityRelationProps(entityRef);
  const properties: Record<string, unknown> = {
    Tema: { title: [{ text: { content: item.tema } }] },
    "Adicionado por": { select: { name: item.adicionadoPor } },
    Urgência: { select: { name: item.urgencia } },
    Área: { select: { name: item.area } },
    Status: { status: { name: "Pendente" satisfies ToDiscussState } },
    Origem: richText(originalMsg),
    ...relProps,
  };
  if (item.resolucao) {
    properties["Resolução"] = richText(item.resolucao);
  }
  if (item.deadline) {
    properties["Deadline"] = { date: { start: item.deadline } };
  }
  const page = await withRetry("createToDiscuss", () =>
    client.pages.create({
      parent: { database_id: NOTION_TO_DISCUSS_DB_ID },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.info("notion.to_discuss_created", {
    id: page.id,
    adicionadoPor: item.adicionadoPor,
  });
  return page.id;
}

async function getToDiscussPending(): Promise<ToDiscussRow[]> {
  if (!NOTION_TO_DISCUSS_DB_ID) {
    throw new Error(
      "NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled",
    );
  }
  const rows: ToDiscussRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRetry("getToDiscussPending", () =>
      client.databases.query({
        database_id: NOTION_TO_DISCUSS_DB_ID,
        filter: {
          property: "Status",
          status: { equals: "Pendente" },
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, unknown>;
      const adicionadoPor = readSelectName(props["Adicionado por"]);
      if (
        adicionadoPor !== "Madalena" &&
        adicionadoPor !== "Mafalda" &&
        adicionadoPor !== "Beatriz"
      ) {
        continue;
      }
      const urgenciaName = readSelectName(props["Urgência"]);
      const urgencia: ToDiscussUrgency =
        urgenciaName === "Próxima reunião" ||
        urgenciaName === "Decisão offline" ||
        urgenciaName === "Urgente"
          ? urgenciaName
          : "Próxima reunião";
      const estadoName = readStatusName(props["Status"]);
      const estado: ToDiscussState =
        estadoName === "Pendente" ||
        estadoName === "Discutido" ||
        estadoName === "Arquivado" ||
        estadoName === "Aberto"
          ? estadoName
          : "Pendente";
      const deadline = readDateStart(props["Deadline"]) ?? undefined;
      rows.push({
        id: row.id,
        tema: readPlainText(props["Tema"]),
        adicionadoPor,
        urgencia,
        area: (readSelectName(props["Área"]) ?? "Outro") as Area,
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

async function setToDiscussResolved(id: string, resolucao: string): Promise<void> {
  if (!NOTION_TO_DISCUSS_DB_ID) {
    throw new Error(
      "NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled",
    );
  }
  await withRetry("setToDiscussResolved", () =>
    client.pages.update({
      page_id: id,
      properties: {
        Status: { status: { name: "Discutido" satisfies ToDiscussState } },
        "Resolução": richText(resolucao),
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.info("notion.to_discuss_resolved", { id });
}

async function createDecision(d: Omit<DecisionRow, "id">, originalMsg: string): Promise<string> {
  if (!NOTION_DECISIONS_DB_ID) {
    throw new Error(
      "NOTION_DECISIONS_DB_ID not set — Phase 5 decision features disabled",
    );
  }
  const properties: Record<string, unknown> = {
    Decisão: { title: [{ text: { content: d.decisao } }] },
    Área: { select: { name: d.area } },
    "Tomada por": {
      multi_select: d.tomadaPor.map((name) => ({ name })),
    },
    Status: { status: { name: d.estado } },
    Origem: richText(originalMsg),
  };
  if (d.notas) {
    properties["Notas"] = richText(d.notas);
  }
  const page = await withRetry("createDecision", () =>
    client.pages.create({
      parent: { database_id: NOTION_DECISIONS_DB_ID },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.info("notion.decision_created", { id: page.id, area: d.area });
  return page.id;
}

async function getRecentDecisions(n: number): Promise<DecisionRow[]> {
  if (!NOTION_DECISIONS_DB_ID) {
    throw new Error(
      "NOTION_DECISIONS_DB_ID not set — Phase 5 decision features disabled",
    );
  }
  const res = await withRetry("getRecentDecisions", () =>
    client.databases.query({
      database_id: NOTION_DECISIONS_DB_ID,
      sorts: [{ property: "Data", direction: "descending" }],
      page_size: Math.min(Math.max(n, 1), 100),
    }),
  );
  const rows: DecisionRow[] = [];
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    const props = row.properties as Record<string, unknown>;
    const tomadaPorNames = readMultiSelectNames(props["Tomada por"]).filter(
      (name): name is FounderName =>
        name === "Madalena" || name === "Mafalda" || name === "Beatriz",
    );
    const estadoName = readStatusName(props["Status"]);
    const estado: DecisionRow["estado"] =
      estadoName === "Implementada"
        ? "Implementada"
        : "Pendente implementação";
    rows.push({
      id: row.id,
      decisao: readPlainText(props["Decisão"]),
      area: (readSelectName(props["Área"]) ?? "Outro") as Area,
      tomadaPor: tomadaPorNames,
      data: readDateStart(props["Data"]),
      estado,
      notas: readPlainText(props["Notas"]),
      origem: readPlainText(props["Origem"]),
    });
  }
  log.debug("notion.recent_decisions_fetched", { count: rows.length });
  return rows;
}

async function setTaskDependency(
  blockedId: string,
  prerequisiteId: string,
): Promise<void> {
  await withRetry("setTaskDependency", () =>
    client.pages.update({
      page_id: blockedId,
      properties: {
        "Depende de": { relation: [{ id: prerequisiteId }] },
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.info("notion.dependency_set", { blockedId, prerequisiteId });
}

async function getDependentTasks(prerequisiteId: string): Promise<OpenTask[]> {
  if (!NOTION_BACKLOG_DB_ID) return [];
  const res = await withRetry("getDependentTasks", () =>
    client.databases.query({
      database_id: NOTION_BACKLOG_DB_ID!,
      filter: {
        and: [
          { property: "Depende de", relation: { contains: prerequisiteId } },
          { property: "Status", status: { equals: "Bloqueado" } },
        ],
      },
    }),
  );
  const tasks: OpenTask[] = [];
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    tasks.push(
      rowToOpenTask({
        id: row.id,
        properties: row.properties as Record<string, unknown>,
      }),
    );
  }
  log.debug("notion.dependents_fetched", {
    prerequisiteId,
    count: tasks.length,
  });
  return tasks;
}

// silence unused-helper warning for readDateTime (kept for callers)
void readDateTime;

// ----- fuzzy / semantic search helpers -----

const PT_STOPWORDS = new Set([
  "o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das",
  "e", "em", "no", "na", "nos", "nas", "para", "já", "com", "por",
  "ao", "à", "que", "se", "não", "mas", "ou", "ao", "às",
]);

const SMALL_DBS = new Set(["projects", "partners", "events", "influencers"]);

function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function scoreMatch(title: string, query: string): number {
  const t = normalizeText(title);
  const q = normalizeText(query);
  if (t === q) return 1;
  if (t.includes(q) || q.includes(t)) return 0.8;
  const tWords = new Set(t.split(/\s+/).filter((w) => w.length > 2));
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  if (qWords.length === 0 || tWords.size === 0) return 0;
  const overlap = qWords.filter(
    (w) => tWords.has(w) || [...tWords].some((tw) => tw.includes(w) || w.includes(tw)),
  ).length;
  return overlap > 0 ? overlap / Math.max(qWords.length, tWords.size) : 0;
}

function significantWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\wàáâãéêíóôõúüç]/gi, ""))
    .filter((w) => w.length > 2 && !PT_STOPWORDS.has(w));
}

// ============================================================
// Feature D — Create entities (project / event / partner / influencer)
// ============================================================

function toggleHeading(title: string): object {
  return {
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: title } }],
      is_toggleable: true,
    },
  };
}

async function createProject(nome: string, owner: OwnerValue, originalMsg: string): Promise<string> {
  if (!NOTION_PROJECTS_DB_ID) {
    throw new Error("NOTION_PROJECTS_DB_ID not set");
  }
  const page = await withRetry("createProject", () =>
    client.pages.create({
      parent: { database_id: NOTION_PROJECTS_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { multi_select: [{ name: owner }] },
        Origem: richText(originalMsg),
      },
    }),
  );
  await withRetry("createProject.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("📋 Contexto"),
        toggleHeading("🎯 Objetivos"),
        toggleHeading("✅ Tasks"),
        toggleHeading("💬 To Discuss"),
        toggleHeading("📋 Decisions"),
        toggleHeading("📎 Recursos"),
        toggleHeading("📓 Notas"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.project_created", { pageId: page.id, nome, owner });
  return page.id;
}

async function createEvent(nome: string, owner: OwnerValue, originalMsg: string): Promise<string> {
  if (!NOTION_EVENT_DB_ID) {
    throw new Error("NOTION_EVENT_DB_ID not set");
  }
  const page = await withRetry("createEvent", () =>
    client.pages.create({
      parent: { database_id: NOTION_EVENT_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { multi_select: [{ name: owner }] },
        Status: { status: { name: "Ideia" } },
        Origem: richText(originalMsg),
      },
    }),
  );
  await withRetry("createEvent.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("📋 Descrição"),
        toggleHeading("📅 Logística"),
        toggleHeading("✅ Tasks"),
        toggleHeading("💬 To Discuss"),
        toggleHeading("📋 Decisions"),
        toggleHeading("📢 Comunicação"),
        toggleHeading("📊 Resultados"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.event_created", { pageId: page.id, nome, owner });
  return page.id;
}

async function createPartner(nome: string, owner: OwnerValue, originalMsg: string): Promise<string> {
  if (!NOTION_PARTNER_DB_ID) {
    throw new Error("NOTION_PARTNER_DB_ID not set");
  }
  const page = await withRetry("createPartner", () =>
    client.pages.create({
      parent: { database_id: NOTION_PARTNER_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { select: { name: owner } },
        Status: { status: { name: "A contactar" satisfies PartnerStatus } },
        Origem: richText(originalMsg),
      },
    }),
  );
  await withRetry("createPartner.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("🤝 Sobre o parceiro"),
        toggleHeading("💼 Deal e proposta"),
        toggleHeading("✅ Tasks"),
        toggleHeading("💬 To Discuss"),
        toggleHeading("📋 Decisions"),
        toggleHeading("📞 Contactos"),
        toggleHeading("📎 Contratos"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.partner_created", { pageId: page.id, nome, owner });
  return page.id;
}

async function createInfluencer(nome: string, owner: OwnerValue, originalMsg: string): Promise<string> {
  if (!NOTION_INFLUENCER_DB_ID) {
    throw new Error("NOTION_INFLUENCER_DB_ID not set");
  }
  const page = await withRetry("createInfluencer", () =>
    client.pages.create({
      parent: { database_id: NOTION_INFLUENCER_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { select: { name: owner } },
        Status: { status: { name: "A contactar" satisfies InfluencerStatus } },
        Origem: richText(originalMsg),
      },
    }),
  );
  await withRetry("createInfluencer.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("👤 Perfil e stats"),
        toggleHeading("🤝 Relação e histórico"),
        toggleHeading("📸 Conteúdo e shoots"),
        toggleHeading("✅ Tasks"),
        toggleHeading("💬 To Discuss"),
        toggleHeading("📋 Decisions"),
        toggleHeading("📎 Briefings"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.influencer_created", { pageId: page.id, nome, owner });
  return page.id;
}

// ----- Page section editing -----

function normalizeSectionName(text: string): string {
  return text
    .replace(/\p{Emoji}/gu, "")
    .replace(/[^\wàáâãéêíóôõúüç\s]/gi, "")
    .toLowerCase()
    .trim();
}

const URL_RE = /^https?:\/\/\S+$/i;

function contentToBlocks(content: string): object[] {
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

async function findPageInDb(
  db: string,
  name: string,
): Promise<{ id: string; title: string } | null> {
  const config = RECORD_DB_CONFIGS[db];
  if (!config) return null;
  const dbId = config.dbId();
  if (!dbId) return null;
  return findRecordByTitle(dbId, config.titleProp, name, db);
}

async function getOrCreateToggleId(pageId: string, sectionName: string): Promise<string> {
  const queryNorm = normalizeSectionName(sectionName);
  const listRes = await withRetry("listPageBlocks", () =>
    client.blocks.children.list({ block_id: pageId, page_size: 100 }),
  );
  for (const block of listRes.results) {
    if (!("type" in block)) continue;
    const b = block as { type: string; id: string; [key: string]: unknown };
    if (!["heading_1", "heading_2", "heading_3"].includes(b.type)) continue;
    const hData = b[b.type] as { rich_text?: Array<{ plain_text?: string }>; is_toggleable?: boolean };
    if (!hData.is_toggleable) continue;
    const blockNorm = normalizeSectionName(
      (hData.rich_text ?? []).map((rt) => rt.plain_text ?? "").join(""),
    );
    if (blockNorm.includes(queryNorm) || queryNorm.includes(blockNorm)) {
      return b.id;
    }
  }
  const label = /^\p{Emoji}/u.test(sectionName.trim()) ? sectionName : `📌 ${sectionName}`;
  const createRes = await withRetry("createToggle", () =>
    client.blocks.children.append({
      block_id: pageId,
      children: [toggleHeading(label)] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  return (createRes.results[0] as { id: string }).id;
}

async function appendToPageSection(
  pageId: string,
  content: string,
  section?: string,
): Promise<void> {
  const blocks = contentToBlocks(content);
  if (!blocks.length) return;
  const children = blocks as Parameters<typeof client.blocks.children.append>[0]["children"];
  const targetId = section ? await getOrCreateToggleId(pageId, section) : pageId;
  await withRetry("appendToSection", () =>
    client.blocks.children.append({ block_id: targetId, children }),
  );
  log.info("notion.page_content_added", { pageId, section: section ?? "root" });
}

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function uploadAndAttachFile(
  pageId: string,
  fileName: string,
  mimeType: string,
  fileBuffer: Buffer,
  section?: string,
): Promise<void> {
  // Step 1 — create file upload entry
  const createRes = await fetch(`${NOTION_API_BASE}/file_uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mode: "single_part", filename: fileName, content_type: mimeType }),
  });
  if (!createRes.ok) {
    const body = await createRes.text();
    throw new Error(`notion: file_upload create ${createRes.status}: ${body}`);
  }
  const { id: uploadId } = await createRes.json() as { id: string };

  // Step 2 — upload file data
  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: mimeType }), fileName);
  const uploadRes = await fetch(`${NOTION_API_BASE}/file_uploads/${uploadId}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
    },
    body: form,
  });
  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`notion: file_upload send ${uploadRes.status}: ${body}`);
  }

  // Step 3 — append image or file block
  const fileBlock = mimeType.startsWith("image/")
    ? {
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: uploadId },
        },
      }
    : {
        type: "file",
        file: {
          type: "file_upload",
          file_upload: { id: uploadId },
          name: fileName,
        },
      };
  const targetId = section ? await getOrCreateToggleId(pageId, section) : pageId;
  await withRetry("appendFile", () =>
    client.blocks.children.append({
      block_id: targetId,
      children: [fileBlock] as unknown as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.file_attached", { pageId, fileName, section });
}

// ----- Lists -----

export interface ListItem {
  id: string;
  item: string;
  lista: string;
  feito: boolean;
  adicionadoPor: string;
}

async function addToList(
  item: string,
  lista: string,
  adicionadoPor: FounderName,
  originalMsg: string,
): Promise<string> {
  if (!NOTION_LISTS_DB_ID) throw new Error("NOTION_LISTS_DB_ID not set");
  const page = await withRetry("addToList", () =>
    client.pages.create({
      parent: { database_id: NOTION_LISTS_DB_ID! },
      properties: {
        Item: { title: [{ text: { content: item.slice(0, 100) } }] },
        Lista: { select: { name: lista } },
        Fechada: { checkbox: false },
        "Adicionado por": { select: { name: adicionadoPor } },
        Origem: richText(originalMsg),
      },
    }),
  );
  log.info("notion.list_item_added", { item, lista, adicionadoPor });
  return page.id;
}

function matchesListName(val: string, q: string): boolean {
  if (val === q || val.includes(q) || q.includes(val)) return true;
  const minLen = Math.min(val.length, q.length);
  if (minLen >= 4) {
    let i = 0;
    while (i < minLen && val[i] === q[i]) i++;
    if (i >= 4) return true;
  }
  return false;
}

let _listNamesCache: { names: string[]; ts: number } | null = null;

async function getListNames(): Promise<string[]> {
  if (!NOTION_LISTS_DB_ID) return [];
  const now = Date.now();
  if (_listNamesCache && now - _listNamesCache.ts < 24 * 60 * 60 * 1000) return _listNamesCache.names;
  try {
    const db = await client.databases.retrieve({ database_id: NOTION_LISTS_DB_ID });
    const listaProp = (db.properties as Record<string, unknown>)["Lista"] as
      | { select?: { options?: { name: string }[] } }
      | undefined;
    const names = listaProp?.select?.options?.map((o) => o.name) ?? [];
    _listNamesCache = { names, ts: now };
    return names;
  } catch {
    return [];
  }
}

async function checkListItem(itemTitle: string, lista: string): Promise<string | null> {
  if (!NOTION_LISTS_DB_ID) throw new Error("NOTION_LISTS_DB_ID not set");

  type Row = { id: string; properties: Record<string, unknown> };
  let rows: Row[];

  try {
    const res = await client.databases.query({
      database_id: NOTION_LISTS_DB_ID!,
      filter: {
        and: [
          { property: "Lista", select: { equals: lista } },
          { property: "Fechada", checkbox: { equals: false } },
        ],
      },
      page_size: 50,
    });
    rows = res.results as Row[];
  } catch {
    // select option not found (400 validation_error) — fetch all open items and match lista in JS
    const res = await withRetry("checkListItem.queryAll", () =>
      client.databases.query({
        database_id: NOTION_LISTS_DB_ID!,
        filter: { property: "Fechada", checkbox: { equals: false } },
        page_size: 100,
      }),
    );
    const listaQ = lista.toLowerCase();
    rows = (res.results as Row[]).filter((row) => {
      const val = (readSelectName(row.properties["Lista"]) ?? "").toLowerCase();
      return matchesListName(val, listaQ);
    });
  }

  // Best title match
  let bestId: string | null = null;
  let bestScore = 0;
  const q = itemTitle.toLowerCase();
  for (const row of rows) {
    const props = row.properties;
    const title = readPlainText(props["Item"]).toLowerCase();
    const exact = title === q ? 1 : 0;
    const includes = title.includes(q) || q.includes(title) ? 0.8 : 0;
    const wa = (() => {
      const wa2 = new Set(q.split(/\s+/).filter(Boolean));
      const wb = new Set(title.split(/\s+/).filter(Boolean));
      if (!wa2.size || !wb.size) return 0;
      let overlap = 0;
      for (const w of wa2) if (wb.has(w)) overlap++;
      return overlap / Math.max(wa2.size, wb.size);
    })();
    const score = exact || includes || wa;
    if (score > bestScore) { bestScore = score; bestId = row.id; }
  }
  if (!bestId || bestScore === 0) return null;

  await withRetry("checkListItem.update", () =>
    client.pages.update({ page_id: bestId!, properties: { Fechada: { checkbox: true } } }),
  );
  log.info("notion.list_item_checked", { itemTitle, lista, pageId: bestId });
  return bestId;
}

async function deleteListItem(itemTitle: string, lista: string): Promise<string | null> {
  if (!NOTION_LISTS_DB_ID) throw new Error("NOTION_LISTS_DB_ID not set");

  type Row = { id: string; properties: Record<string, unknown> };
  let rows: Row[];

  try {
    const res = await client.databases.query({
      database_id: NOTION_LISTS_DB_ID!,
      filter: {
        and: [
          { property: "Lista", select: { equals: lista } },
          { property: "Fechada", checkbox: { equals: false } },
        ],
      },
      page_size: 50,
    });
    rows = res.results as Row[];
  } catch {
    const res = await withRetry("deleteListItem.queryAll", () =>
      client.databases.query({
        database_id: NOTION_LISTS_DB_ID!,
        filter: { property: "Fechada", checkbox: { equals: false } },
        page_size: 100,
      }),
    );
    const listaQ = lista.toLowerCase();
    rows = (res.results as Row[]).filter((row) => {
      const val = (readSelectName(row.properties["Lista"]) ?? "").toLowerCase();
      return matchesListName(val, listaQ);
    });
  }

  let bestId: string | null = null;
  let bestScore = 0;
  const q = itemTitle.toLowerCase();
  for (const row of rows) {
    const props = row.properties;
    const title = readPlainText(props["Item"]).toLowerCase();
    const exact = title === q ? 1 : 0;
    const includes = title.includes(q) || q.includes(title) ? 0.8 : 0;
    const wa = (() => {
      const wa2 = new Set(q.split(/\s+/).filter(Boolean));
      const wb = new Set(title.split(/\s+/).filter(Boolean));
      if (!wa2.size || !wb.size) return 0;
      let overlap = 0;
      for (const w of wa2) if (wb.has(w)) overlap++;
      return overlap / Math.max(wa2.size, wb.size);
    })();
    const score = exact || includes || wa;
    if (score > bestScore) { bestScore = score; bestId = row.id; }
  }
  if (!bestId || bestScore === 0) return null;

  await withRetry("deleteListItem.archive", () =>
    client.pages.update({ page_id: bestId!, archived: true }),
  );
  log.info("notion.list_item_deleted", { itemTitle, lista, pageId: bestId });
  return bestId;
}

async function getList(lista?: string): Promise<ListItem[]> {
  if (!NOTION_LISTS_DB_ID) return [];

  type Row = { id: string; properties: Record<string, unknown> };
  let rows: Row[];

  if (lista) {
    try {
      const res = await client.databases.query({
        database_id: NOTION_LISTS_DB_ID!,
        filter: { property: "Lista", select: { equals: lista } },
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
      });
      rows = res.results as Row[];
    } catch {
      // select option not found — fetch all and filter in JS
      const res = await withRetry("getList.fallback", () =>
        client.databases.query({
          database_id: NOTION_LISTS_DB_ID!,
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          page_size: 100,
        }),
      );
      const q = lista.toLowerCase();
      rows = (res.results as Row[]).filter((row) => {
        const val = (readSelectName(row.properties["Lista"]) ?? "").toLowerCase();
        return matchesListName(val, q);
      });
    }
  } else {
    const res = await withRetry("getList", () =>
      client.databases.query({
        database_id: NOTION_LISTS_DB_ID!,
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        page_size: 100,
      }),
    );
    rows = res.results as Row[];
  }

  return rows.map((row) => {
    const props = row.properties;
    const feito =
      props["Fechada"] &&
      typeof props["Fechada"] === "object" &&
      "checkbox" in (props["Fechada"] as object)
        ? (props["Fechada"] as { checkbox: boolean }).checkbox
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

// ----- Entity dashboards -----

export interface EntitySummary {
  id: string;
  name: string;
  status: string | null;
}

async function getEntitiesForOwner(
  dbKey: "projects" | "partners" | "events" | "influencers",
  owner: FounderName,
): Promise<EntitySummary[]> {
  const cfg = RECORD_DB_CONFIGS[dbKey];
  const dbId = cfg?.dbId();
  if (!cfg || !dbId) return [];

  const ownerFieldConfig = cfg.fields["owner"];
  const ownerType = ownerFieldConfig ? ownerFieldConfig.type : "select";
  const ownerFilter =
    ownerType === "multi_select"
      ? { property: "Owner", multi_select: { contains: owner } }
      : { property: "Owner", select: { equals: owner } };

  const mapRow = (r: { id: string; properties: Record<string, unknown> }): EntitySummary => ({
    id: r.id,
    name: readPlainText(r.properties["Name"]) || "—",
    status: readStatusName(r.properties["Status"]) ?? null,
  });

  try {
    const res = await client.databases.query({
      database_id: dbId,
      filter: ownerFilter as Parameters<typeof client.databases.query>[0]["filter"],
      page_size: 20,
    });
    return res.results
      .filter((r) => "properties" in r)
      .map((r) => mapRow({ id: r.id, properties: (r as { properties: Record<string, unknown> }).properties }));
  } catch {
    // select/multi_select option not found — fetch all and filter in JS
    try {
      const res = await withRetry(`getEntitiesForOwner.${dbKey}.fallback`, () =>
        client.databases.query({ database_id: dbId, page_size: 100 }),
      );
      const ownerLower = owner.toLowerCase();
      return res.results
        .filter((r) => "properties" in r)
        .filter((r) => {
          const props = (r as { properties: Record<string, unknown> }).properties;
          const val = (readSelectName(props["Owner"]) ?? readMultiSelectNames(props["Owner"]).join(",")).toLowerCase();
          return val.includes(ownerLower);
        })
        .map((r) => mapRow({ id: r.id, properties: (r as { properties: Record<string, unknown> }).properties }));
    } catch (err) {
      log.warn("notion.getEntitiesForOwner_failed", { dbKey, err: String(err) });
      return [];
    }
  }
}

async function getTasksForEntity(
  entityField: string,
  entityPageId: string,
): Promise<{ title: string }[]> {
  if (!NOTION_BACKLOG_DB_ID) return [];
  try {
    const res = await withRetry("getTasksForEntity", () =>
      client.databases.query({
        database_id: NOTION_BACKLOG_DB_ID!,
        filter: {
          and: [
            { property: entityField, relation: { contains: entityPageId } },
            { property: "Status", status: { does_not_equal: "Feito" } },
            { property: "Status", status: { does_not_equal: "Cancelado" } },
          ],
        } as Parameters<typeof client.databases.query>[0]["filter"],
        page_size: 10,
      }),
    );
    return res.results
      .filter((r) => "properties" in r)
      .map((r) => ({
        title:
          readPlainText(
            (r as { properties: Record<string, unknown> }).properties["Título"],
          ) || "—",
      }));
  } catch (err) {
    log.warn("notion.getTasksForEntity_failed", { entityField, entityPageId, err: String(err) });
    return [];
  }
}

// Named exports so callers can use either `import * as notion` or `import { notion }`.
export {
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
  cancelReminder,
  // Phase 5
  createToDiscuss,
  getToDiscussPending,
  setToDiscussResolved,
  createDecision,
  getRecentDecisions,
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
  deleteListItem,
  getList,
  getListNames,
  // Generic record update
  updateRecord,
  findBacklogTask,
  searchRecords,
  // Page section editing
  findPageInDb,
  appendToPageSection,
  uploadAndAttachFile,
  // Entity dashboards
  getEntitiesForOwner,
  getTasksForEntity,
};

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
  cancelReminder,
  // Phase 5
  createToDiscuss,
  getToDiscussPending,
  setToDiscussResolved,
  createDecision,
  getRecentDecisions,
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
  deleteListItem,
  getList,
  getListNames,
  // Generic record update
  updateRecord,
  findBacklogTask,
  searchRecords,
  // Page section editing
  findPageInDb,
  appendToPageSection,
  uploadAndAttachFile,
  // Entity dashboards
  getEntitiesForOwner,
  getTasksForEntity,
};
