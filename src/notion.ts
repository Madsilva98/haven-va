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
import type {
  EditableField,
  EntityKind,
  EntityRef,
  FeedbackEntry,
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
const NOTION_FEEDBACK_DB_ID = process.env.NOTION_FEEDBACK_DB_ID;
const NOTION_PENDING_DB_ID = process.env.NOTION_PENDING_DB_ID;

// Phase 2/3/5 — all optional
const NOTION_FOUNDER_FOCUS_DB_ID = process.env.NOTION_FOUNDER_FOCUS_DB_ID;
const NOTION_PARTNER_DB_ID = process.env.NOTION_PARTNER_DB_ID;
const NOTION_INFLUENCER_DB_ID = process.env.NOTION_INFLUENCER_DB_ID;
const NOTION_REMINDERS_DB_ID = process.env.NOTION_REMINDERS_DB_ID;
const NOTION_TO_DISCUSS_DB_ID = process.env.NOTION_TO_DISCUSS_DB_ID;
const NOTION_DECISIONS_DB_ID = process.env.NOTION_DECISIONS_DB_ID;
const NOTION_CONTENT_CALENDAR_DB_ID =
  process.env.NOTION_CONTENT_CALENDAR_DB_ID;
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
if (!NOTION_FEEDBACK_DB_ID) {
  throw new Error("notion: NOTION_FEEDBACK_DB_ID is required");
}
if (!NOTION_PENDING_DB_ID) {
  throw new Error("notion: NOTION_PENDING_DB_ID is required");
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
const FEEDBACK_TTL_MS = 5 * 60 * 1000;

let openTasksCache: { value: OpenTask[]; expiresAt: number } | null = null;
let recentFeedbackCache: {
  n: number;
  value: FeedbackEntry[];
  expiresAt: number;
} | null = null;

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
      return { [property]: { select: { name: newValue } } };
    case "owner":
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
  if (!pageId) return {};
  return { [ENTITY_KIND_TO_FIELD[entityRef.kind]]: { relation: [{ id: pageId }] } };
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
  const notas = `originating: ${sender}: "${originalMsg}"\nwhy: ${extraction.why}`;
  const relProps = await entityRelationProps(entityRef);

  const props: Record<string, unknown> = {
    "Título": { title: [{ text: { content: extraction.title } }] },
    Owner: { select: { name: extraction.owner } },
    "Área": { select: { name: extraction.area } },
    Prioridade: { select: { name: priority } },
    Status: { select: { name: "A fazer" satisfies Status } },
    Notas: richText(notas),
    ...relProps,
  };
  if (deadline) props["Deadline"] = { date: { start: deadline } };

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
  const properties = buildEditPatch(field, newValue);
  await withRetry("updateTask", () =>
    client.pages.update({
      page_id: pageId,
      properties: properties as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  invalidateOpenTasksCache();
  log.info("notion.task_updated", { pageId, field, newValue });
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
            { property: "Status", select: { does_not_equal: "Feito" } },
            { property: "Status", select: { does_not_equal: "Cancelado" } },
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
      const statusName = readSelectName(props["Status"]) ?? "A fazer";
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

async function logFeedback(entry: FeedbackEntry): Promise<void> {
  const properties: Record<string, unknown> = {
    Tipo: { select: { name: entry.type } },
    "Mensagem original": richText(entry.originalMsg),
    Sender: { select: { name: entry.sender } },
    "Bot extraction": richText(entry.botExtraction),
    "Tua acção": { select: { name: entry.userAction } },
  };
  if (entry.userText !== undefined) {
    properties["Texto da correcção"] = richText(entry.userText);
  }

  await withRetry("logFeedback", () =>
    client.pages.create({
      parent: { database_id: NOTION_FEEDBACK_DB_ID! },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.info("notion.feedback_logged", { type: entry.type, sender: entry.sender });
}

async function getRecentFeedback(n = 20): Promise<FeedbackEntry[]> {
  const now = Date.now();
  if (
    recentFeedbackCache &&
    recentFeedbackCache.n === n &&
    recentFeedbackCache.expiresAt > now
  ) {
    return recentFeedbackCache.value;
  }

  const res = await withRetry("getRecentFeedback", () =>
    client.databases.query({
      database_id: NOTION_FEEDBACK_DB_ID!,
      sorts: [{ property: "Data", direction: "descending" }],
      page_size: Math.min(n, 100),
    }),
  );

  const entries: FeedbackEntry[] = [];
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    const props = row.properties as Record<string, unknown>;
    const typeName = readSelectName(props["Tipo"]);
    if (
      typeName !== "confirmed" &&
      typeName !== "false_positive" &&
      typeName !== "correction"
    ) {
      continue;
    }
    const senderName = readSelectName(props["Sender"]);
    if (
      senderName !== "Madalena" &&
      senderName !== "Mafalda" &&
      senderName !== "Beatriz"
    ) {
      continue;
    }
    const userText = readPlainText(props["Texto da correcção"]);
    entries.push({
      type: typeName,
      originalMsg: readPlainText(props["Mensagem original"]),
      sender: senderName,
      botExtraction: readPlainText(props["Bot extraction"]),
      userAction: readSelectName(props["Tua acção"]) ?? "",
      ...(userText ? { userText } : {}),
    });
  }

  recentFeedbackCache = {
    n,
    value: entries,
    expiresAt: now + FEEDBACK_TTL_MS,
  };
  log.debug("notion.recent_feedback_fetched", { count: entries.length });
  return entries;
}

// ----- Bot Pending DB (replaces in-memory pending state for Vercel serverless) -----

import type { PendingProposal, RecentAction, IntentType } from "./types.js";

async function createPending(
  proposal: PendingProposal,
  chatId: number,
): Promise<void> {
  // Title is just human-readable; lookup is by Bot Message ID number.
  const properties: Record<string, unknown> = {
    Título: {
      title: [{ text: { content: `Pending #${proposal.botMessageId}` } }],
    },
    "Bot Message ID": { number: proposal.botMessageId },
    "Chat ID": { number: chatId },
    Tipo: { select: { name: proposal.type } },
    Extraction: richText(JSON.stringify(proposal.extraction)),
    "Mensagem original": richText(proposal.originalMsg),
    Sender: { select: { name: proposal.originalSender } },
    Committed: { checkbox: false },
    Cancelled: { checkbox: false },
  };

  await withRetry("createPending", () =>
    client.pages.create({
      parent: { database_id: NOTION_PENDING_DB_ID! },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.debug("notion.pending_created", {
    botMessageId: proposal.botMessageId,
    chatId,
  });
}

async function markCommitted(
  botMessageId: number,
  notionPageId: string | null,
): Promise<void> {
  const res = await withRetry("markCommitted.find", () =>
    client.databases.query({
      database_id: NOTION_PENDING_DB_ID!,
      filter: {
        property: "Bot Message ID",
        number: { equals: botMessageId },
      },
      page_size: 1,
    }),
  );
  const page = res.results[0];
  if (!page) return;

  const properties: Record<string, unknown> = {
    Committed: { checkbox: true },
  };
  if (notionPageId !== null) {
    properties["Notion Page ID"] = richText(notionPageId);
  }

  await withRetry("markCommitted.update", () =>
    client.pages.update({
      page_id: page.id,
      properties: properties as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.debug("notion.pending_committed", { botMessageId, notionPageId });
}

async function markCancelled(botMessageId: number): Promise<void> {
  const res = await withRetry("markCancelled.find", () =>
    client.databases.query({
      database_id: NOTION_PENDING_DB_ID!,
      filter: {
        property: "Bot Message ID",
        number: { equals: botMessageId },
      },
      page_size: 1,
    }),
  );
  const page = res.results[0];
  if (!page) return;

  await withRetry("markCancelled.update", () =>
    client.pages.update({
      page_id: page.id,
      properties: {
        Cancelled: { checkbox: true },
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.debug("notion.pending_cancelled", { botMessageId });
}

async function getRecentActions(
  chatId: number,
  ttlMinutes: number,
  limit: number,
): Promise<RecentAction[]> {
  const sinceIso = new Date(Date.now() - ttlMinutes * 60 * 1000).toISOString();

  const res = await withRetry("getRecentActions", () =>
    client.databases.query({
      database_id: NOTION_PENDING_DB_ID!,
      filter: {
        and: [
          { property: "Chat ID", number: { equals: chatId } },
          { property: "Cancelled", checkbox: { equals: false } },
          {
            timestamp: "created_time",
            created_time: { on_or_after: sinceIso },
          },
        ],
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: limit,
    }),
  );

  const actions: RecentAction[] = [];
  for (const page of res.results) {
    if (!("properties" in page)) continue;
    const props = page.properties as Record<string, unknown>;

    try {
      const tipo = readSelectName(props["Tipo"]);
      let type: IntentType;
      let idPrefix: string;
      if (tipo === "new_task") {
        type = "NEW_TASK";
        idPrefix = "t";
      } else if (tipo === "edit") {
        type = "EDIT_TASK";
        idPrefix = "e";
      } else {
        continue;
      }

      const committed = readCheckbox(props["Committed"]);
      const status: RecentAction["status"] = committed ? "committed" : "pending";

      const botMessageIdRaw = props["Bot Message ID"];
      const botMessageId =
        botMessageIdRaw &&
        typeof botMessageIdRaw === "object" &&
        "number" in botMessageIdRaw &&
        typeof (botMessageIdRaw as { number: unknown }).number === "number"
          ? (botMessageIdRaw as { number: number }).number
          : null;

      const id =
        botMessageId !== null
          ? `${idPrefix}${botMessageId % 1000}`
          : `${idPrefix}?`;

      const extractionRaw = readPlainText(props["Extraction"]);
      let summary: string;
      try {
        const extraction = JSON.parse(extractionRaw) as Record<string, unknown>;
        if (type === "NEW_TASK") {
          summary = `${extraction["title"] ?? ""} (${extraction["area"] ?? ""}, ${extraction["owner"] ?? ""})`;
        } else {
          summary = `edição: ${extraction["field"] ?? ""} → ${extraction["newValue"] ?? ""} em ${extraction["targetTitle"] ?? ""}`;
        }
      } catch {
        continue;
      }

      const createdAt =
        "created_time" in page ? Date.parse(page.created_time) : Date.now();

      const notionPageIdText = readPlainText(props["Notion Page ID"]);
      const notionPageId = notionPageIdText.length > 0 ? notionPageIdText : null;

      actions.push({
        id,
        type,
        status,
        summary,
        createdAt,
        notionPageId,
        botMessageId,
      });
    } catch (err) {
      log.warn("notion.recent_action_map_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  return actions;
}

async function getPending(botMessageId: number): Promise<PendingProposal | null> {
  const res = await withRetry("getPending", () =>
    client.databases.query({
      database_id: NOTION_PENDING_DB_ID!,
      filter: {
        and: [
          { property: "Bot Message ID", number: { equals: botMessageId } },
          { property: "Committed", checkbox: { equals: false } },
          { property: "Cancelled", checkbox: { equals: false } },
        ],
      },
      page_size: 1,
    }),
  );

  if (res.results.length === 0) return null;
  const page = res.results[0];
  if (!page || !("properties" in page)) return null;
  const props = page.properties as Record<string, unknown>;

  const type = readSelectName(props["Tipo"]);
  if (type !== "new_task" && type !== "edit") return null;

  const sender = readSelectName(props["Sender"]);
  if (sender !== "Madalena" && sender !== "Mafalda" && sender !== "Beatriz") {
    return null;
  }

  const extractionRaw = readPlainText(props["Extraction"]);
  let extraction: unknown;
  try {
    extraction = JSON.parse(extractionRaw);
  } catch {
    log.warn("notion.pending_parse_failed", { botMessageId });
    return null;
  }

  const originalMsg = readPlainText(props["Mensagem original"]);
  const createdAt = "created_time" in page ? new Date(page.created_time).getTime() : Date.now();

  // Stash the Notion page id on the proposal via a side channel:
  // we use it for delete; piggyback on a custom field of PendingProposal.
  const proposal = {
    type,
    botMessageId,
    extraction,
    originalMsg,
    originalSender: sender,
    createdAt,
    _notionPageId: page.id,
  } as PendingProposal & { _notionPageId: string };

  return proposal;
}

async function deletePending(botMessageId: number): Promise<void> {
  // Find the page first, then archive it.
  const res = await withRetry("deletePending.find", () =>
    client.databases.query({
      database_id: NOTION_PENDING_DB_ID!,
      filter: {
        property: "Bot Message ID",
        number: { equals: botMessageId },
      },
      page_size: 1,
    }),
  );
  const page = res.results[0];
  if (!page) return;

  await withRetry("deletePending.archive", () =>
    client.pages.update({
      page_id: page.id,
      archived: true,
    }),
  );
  log.debug("notion.pending_deleted", { botMessageId });
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
    priorityName === "Alta" || priorityName === "Média" || priorityName === "Baixa"
      ? (priorityName as Priority)
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
            { property: "Status", select: { does_not_equal: "Feito" } },
            { property: "Status", select: { does_not_equal: "Cancelado" } },
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
            { property: "Status", select: { equals: "Feito" } },
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
            { property: "Status", select: { does_not_equal: "Feito" } },
            { property: "Status", select: { does_not_equal: "Cancelado" } },
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
    throw new Error(
      "NOTION_FOUNDER_FOCUS_DB_ID not set — Phase 2 founder focus features disabled",
    );
  }
  // Find existing row by Founder (title) + Semana (rich_text)
  const res = await withRetry("setFounderFocus.find", () =>
    client.databases.query({
      database_id: NOTION_FOUNDER_FOCUS_DB_ID,
      filter: {
        and: [
          { property: "Founder", title: { equals: entry.founder } },
          { property: "Semana", rich_text: { equals: entry.semana } },
        ],
      },
      page_size: 1,
    }),
  );

  const properties: Record<string, unknown> = {
    Founder: { title: [{ text: { content: entry.founder } }] },
    Semana: richText(entry.semana),
    "Foco operacional": richText(entry.focoOperacional),
  };

  const existing = res.results[0];
  if (existing) {
    await withRetry("setFounderFocus.update", () =>
      client.pages.update({
        page_id: existing.id,
        properties: properties as Parameters<typeof client.pages.update>[0]["properties"],
      }),
    );
    log.info("notion.founder_focus_updated", {
      founder: entry.founder,
      semana: entry.semana,
    });
  } else {
    await withRetry("setFounderFocus.create", () =>
      client.pages.create({
        parent: { database_id: NOTION_FOUNDER_FOCUS_DB_ID },
        properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
      }),
    );
    log.info("notion.founder_focus_created", {
      founder: entry.founder,
      semana: entry.semana,
    });
  }
}

async function getFounderFocusForWeek(week: string): Promise<FounderFocusEntry[]> {
  if (!NOTION_FOUNDER_FOCUS_DB_ID) {
    throw new Error(
      "NOTION_FOUNDER_FOCUS_DB_ID not set — Phase 2 founder focus features disabled",
    );
  }
  const res = await withRetry("getFounderFocusForWeek", () =>
    client.databases.query({
      database_id: NOTION_FOUNDER_FOCUS_DB_ID,
      filter: {
        property: "Semana",
        rich_text: { equals: week },
      },
    }),
  );
  const entries: FounderFocusEntry[] = [];
  for (const row of res.results) {
    if (!("properties" in row)) continue;
    const props = row.properties as Record<string, unknown>;
    const founderName = readPlainText(props["Founder"]);
    if (
      founderName !== "Madalena" &&
      founderName !== "Mafalda" &&
      founderName !== "Beatriz"
    ) {
      continue;
    }
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
            { property: "Status", select: { equals: "Contactado" } },
            { property: "Status", select: { equals: "A aguardar resposta" } },
          ],
        }
      : { property: "Status", select: { equals: "Em negociação" } };

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
      const status = readSelectName(props["Status"]) as PartnerStatus | null;
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
      ? { property: "Status", select: { equals: "Contactado" } }
      : { property: "Status", select: { equals: "Em conversa" } };

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
      const status = readSelectName(props["Status"]) as InfluencerStatus | null;
      rows.push({
        id: row.id,
        nome: readPlainText(props["Name"]),
        instagram: readUrl(props["Instagram"]),
        owner: (readSelectName(props["Owner"]) ?? "Unassigned") as OwnerValue,
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

// ── Studio Log (Phase 1 redesign) ────────────────────────────────────────────
async function createLogEntry(params: {
  text: string;
  author: FounderName;
  tags: string[];
  originalMessage: string;
}): Promise<string> {
  if (!NOTION_STUDIO_LOG_DB_ID) {
    throw new Error(
      "NOTION_STUDIO_LOG_DB_ID not set — Studio Log features disabled",
    );
  }
  const properties: Record<string, unknown> = {
    Texto: { title: [{ text: { content: params.text } }] },
    Data: { date: { start: new Date().toISOString() } },
    Autor: { select: { name: params.author } },
    Tags: {
      multi_select: params.tags.slice(0, 3).map((name) => ({ name })),
    },
    "Mensagem original": richText(params.originalMessage),
  };
  const page = await withRetry("createLogEntry", () =>
    client.pages.create({
      parent: { database_id: NOTION_STUDIO_LOG_DB_ID },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
  log.info("notion.log_entry_created", { id: page.id, author: params.author });
  return page.id;
}

async function createReminder(
  r: Omit<ReminderRow, "id" | "enviado">,
): Promise<string> {
  if (!NOTION_REMINDERS_DB_ID) {
    throw new Error(
      "NOTION_REMINDERS_DB_ID not set — Phase 3 reminder features disabled",
    );
  }
  const properties: Record<string, unknown> = {
    Texto: { title: [{ text: { content: r.texto } }] },
    "Para quem": { select: { name: r.paraQuem } },
    Quando: { date: { start: r.quando } },
    Origem: richText(r.origem),
    Enviado: { checkbox: false },
  };
  const page = await withRetry("createReminder", () =>
    client.pages.create({
      parent: { database_id: NOTION_REMINDERS_DB_ID },
      properties: properties as Parameters<typeof client.pages.create>[0]["properties"],
    }),
  );
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
            { property: "Quando", date: { on_or_before: now } },
          ],
        },
        start_cursor: cursor,
      }),
    );
    for (const row of res.results) {
      if (!("properties" in row)) continue;
      const props = row.properties as Record<string, unknown>;
      const paraQuem = readSelectName(props["Para quem"]);
      if (
        paraQuem !== "Madalena" &&
        paraQuem !== "Mafalda" &&
        paraQuem !== "Beatriz"
      ) {
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

// ============================================================
// Phase 5 — To Discuss / Decisions
// ============================================================

async function createToDiscuss(
  item: Omit<ToDiscussRow, "id" | "data" | "estado">,
): Promise<string> {
  if (!NOTION_TO_DISCUSS_DB_ID) {
    throw new Error(
      "NOTION_TO_DISCUSS_DB_ID not set — Phase 5 to-discuss features disabled",
    );
  }
  const properties: Record<string, unknown> = {
    "Name": { title: [{ text: { content: item.tema } }] },
    "Adicionado por": { select: { name: item.adicionadoPor } },
    Urgência: { select: { name: item.urgencia } },
    Área: { select: { name: item.area } },
    Estado: { select: { name: "Pendente" satisfies ToDiscussState } },
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
          property: "Estado",
          select: { equals: "Pendente" },
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
      const estadoName = readSelectName(props["Estado"]);
      const estado: ToDiscussState =
        estadoName === "Pendente" ||
        estadoName === "Discutido" ||
        estadoName === "Arquivado"
          ? estadoName
          : "Pendente";
      const deadline = readDateStart(props["Deadline"]) ?? undefined;
      rows.push({
        id: row.id,
        tema: readPlainText(props["Name"]),
        adicionadoPor,
        urgencia,
        area: (readSelectName(props["Área"]) ?? "Outro") as Area,
        estado,
        data: readDateStart(props["Data"]) ?? "",
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
        Estado: { select: { name: "Discutido" satisfies ToDiscussState } },
        "Resolução": richText(resolucao),
      } as Parameters<typeof client.pages.update>[0]["properties"],
    }),
  );
  log.info("notion.to_discuss_resolved", { id });
}

async function createDecision(d: Omit<DecisionRow, "id">): Promise<string> {
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
    Estado: { select: { name: d.estado } },
  };
  if (d.data) {
    properties["Data"] = { date: { start: d.data } };
  }
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
    const estadoName = readSelectName(props["Estado"]);
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
          { property: "Status", select: { equals: "Bloqueado" } },
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

async function createProject(nome: string, owner: OwnerValue): Promise<string> {
  if (!NOTION_PROJECTS_DB_ID) {
    throw new Error("NOTION_PROJECTS_DB_ID not set");
  }
  const page = await withRetry("createProject", () =>
    client.pages.create({
      parent: { database_id: NOTION_PROJECTS_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { select: { name: owner } },
      },
    }),
  );
  await withRetry("createProject.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("📋 Tarefas"),
        toggleHeading("💬 To Discuss"),
        toggleHeading("📖 Histórico"),
        toggleHeading("📝 Notas"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.project_created", { pageId: page.id, nome, owner });
  return page.id;
}

async function createEvent(nome: string, owner: OwnerValue): Promise<string> {
  if (!NOTION_EVENT_DB_ID) {
    throw new Error("NOTION_EVENT_DB_ID not set");
  }
  const page = await withRetry("createEvent", () =>
    client.pages.create({
      parent: { database_id: NOTION_EVENT_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { select: { name: owner } },
        Status: { select: { name: "A planear" } },
      },
    }),
  );
  await withRetry("createEvent.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("📅 Detalhes"),
        toggleHeading("🎯 Objetivos"),
        toggleHeading("📋 Tarefas"),
        toggleHeading("📝 Notas"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.event_created", { pageId: page.id, nome, owner });
  return page.id;
}

async function createPartner(nome: string, owner: OwnerValue): Promise<string> {
  if (!NOTION_PARTNER_DB_ID) {
    throw new Error("NOTION_PARTNER_DB_ID not set");
  }
  const page = await withRetry("createPartner", () =>
    client.pages.create({
      parent: { database_id: NOTION_PARTNER_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { select: { name: owner } },
        Status: { select: { name: "A contactar" satisfies PartnerStatus } },
      },
    }),
  );
  await withRetry("createPartner.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("🤝 Contactos"),
        toggleHeading("📋 Tarefas"),
        toggleHeading("📖 Histórico"),
        toggleHeading("📝 Notas"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.partner_created", { pageId: page.id, nome, owner });
  return page.id;
}

async function createInfluencer(nome: string, owner: OwnerValue): Promise<string> {
  if (!NOTION_INFLUENCER_DB_ID) {
    throw new Error("NOTION_INFLUENCER_DB_ID not set");
  }
  const page = await withRetry("createInfluencer", () =>
    client.pages.create({
      parent: { database_id: NOTION_INFLUENCER_DB_ID! },
      properties: {
        "Name": { title: [{ text: { content: nome } }] },
        Owner: { select: { name: owner } },
        Status: { select: { name: "A identificar" satisfies InfluencerStatus } },
      },
    }),
  );
  await withRetry("createInfluencer.sections", () =>
    client.blocks.children.append({
      block_id: page.id,
      children: [
        toggleHeading("📱 Stats"),
        toggleHeading("📋 Tarefas"),
        toggleHeading("📖 Histórico"),
        toggleHeading("📝 Notas"),
      ] as Parameters<typeof client.blocks.children.append>[0]["children"],
    }),
  );
  log.info("notion.influencer_created", { pageId: page.id, nome, owner });
  return page.id;
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
): Promise<string> {
  if (!NOTION_LISTS_DB_ID) throw new Error("NOTION_LISTS_DB_ID not set");
  const page = await withRetry("addToList", () =>
    client.pages.create({
      parent: { database_id: NOTION_LISTS_DB_ID! },
      properties: {
        Item: { title: [{ text: { content: item.slice(0, 100) } }] },
        Lista: { select: { name: lista } },
        Feito: { checkbox: false },
        "Adicionado por": { select: { name: adicionadoPor } },
      },
    }),
  );
  log.info("notion.list_item_added", { item, lista, adicionadoPor });
  return page.id;
}

async function checkListItem(itemTitle: string, lista: string): Promise<string | null> {
  if (!NOTION_LISTS_DB_ID) throw new Error("NOTION_LISTS_DB_ID not set");
  const res = await withRetry("checkListItem.query", () =>
    client.databases.query({
      database_id: NOTION_LISTS_DB_ID!,
      filter: {
        and: [
          { property: "Lista", select: { equals: lista } },
          { property: "Feito", checkbox: { equals: false } },
        ],
      },
      page_size: 50,
    }),
  );

  // Best title match
  let bestId: string | null = null;
  let bestScore = 0;
  const q = itemTitle.toLowerCase();
  for (const row of res.results) {
    const props = (row as { id: string; properties: Record<string, unknown> }).properties;
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
    client.pages.update({ page_id: bestId!, properties: { Feito: { checkbox: true } } }),
  );
  log.info("notion.list_item_checked", { itemTitle, lista, pageId: bestId });
  return bestId;
}

async function getList(lista?: string): Promise<ListItem[]> {
  if (!NOTION_LISTS_DB_ID) return [];
  const filter = lista
    ? { property: "Lista", select: { equals: lista } }
    : undefined;
  const res = await withRetry("getList", () =>
    client.databases.query({
      database_id: NOTION_LISTS_DB_ID!,
      ...(filter ? { filter } : {}),
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 100,
    }),
  );
  return res.results.map((row) => {
    const props = (row as { id: string; properties: Record<string, unknown> }).properties;
    const feito =
      props["Feito"] &&
      typeof props["Feito"] === "object" &&
      "checkbox" in (props["Feito"] as object)
        ? (props["Feito"] as { checkbox: boolean }).checkbox
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
export {
  createTask,
  updateTask,
  getOpenTasks,
  invalidateOpenTasksCache,
  logFeedback,
  getRecentFeedback,
  createPending,
  getPending,
  deletePending,
  markCommitted,
  markCancelled,
  archivePage,
  getRecentActions,
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
};

export const notion = {
  createTask,
  updateTask,
  getOpenTasks,
  invalidateOpenTasksCache,
  logFeedback,
  getRecentFeedback,
  createPending,
  getPending,
  deletePending,
  markCommitted,
  markCancelled,
  archivePage,
  getRecentActions,
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
};
