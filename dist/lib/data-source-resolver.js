/**
 * Resolves Notion database IDs to data_source IDs at startup.
 *
 * As of Notion API version 2025-09-03, databases contain one or more
 * "data sources" — the actual schema-bearing entities. The deprecated
 * `databases.query()` endpoint cannot handle multi-source databases
 * and the new `dataSources.query()` requires a data_source_id directly.
 *
 * haven-va's invariant: every configured database must have exactly
 * one data source. This module enforces that invariant loudly at
 * startup, so a "user added a second data source via the Notion UI"
 * scenario fails fast instead of silently breaking reads/writes.
 *
 * Usage:
 *   await initializeDataSources(client, [NOTION_BACKLOG_DB_ID, ...]);
 *   // ...later, anywhere:
 *   const id = dsId(NOTION_BACKLOG_DB_ID);
 *   await client.dataSources.query({ data_source_id: id, ... });
 *
 * See docs/knowledge-base/notion-api-gotchas.md for the underlying
 * Notion model change.
 */
import { log } from "./log.js";
const dataSourceIdByDatabaseId = new Map();
let initialized = false;
export async function initializeDataSources(client, databaseIds) {
    const unique = Array.from(new Set(databaseIds.filter((id) => typeof id === "string" && id.length > 0)));
    log.info("notion.data_source_resolve_start", { count: unique.length });
    for (const databaseId of unique) {
        const db = await client.databases.retrieve({ database_id: databaseId });
        // The v5 SDK types don't expose data_sources directly on the union
        // GetDatabaseResponse type, but it's always present on full database
        // objects since 2025-09-03.
        const dataSources = db.data_sources;
        if (!dataSources || dataSources.length === 0) {
            log.error("notion.no_data_source", { databaseId });
            throw new Error(`Database ${databaseId} has no data sources. ` +
                `Cannot initialize haven-va — see docs/knowledge-base/notion-api-gotchas.md.`);
        }
        if (dataSources.length > 1) {
            log.error("notion.multi_data_source_detected", {
                databaseId,
                count: dataSources.length,
                names: dataSources.map((d) => d.name),
            });
            throw new Error(`Database ${databaseId} has ${dataSources.length} data sources ` +
                `(names: ${dataSources.map((d) => d.name).join(", ")}). ` +
                `haven-va requires exactly 1. See docs/knowledge-base/notion-api-gotchas.md ` +
                `"multi-source breaking trap" section.`);
        }
        const onlySource = dataSources[0];
        dataSourceIdByDatabaseId.set(databaseId, onlySource.id);
        log.info("notion.data_source_resolved", {
            databaseId,
            dataSourceId: onlySource.id,
            name: onlySource.name,
        });
    }
    initialized = true;
    log.info("notion.data_source_resolve_done", { count: unique.length });
}
export function dsId(databaseId) {
    if (!initialized) {
        throw new Error(`dsId(${databaseId}) called before initializeDataSources(). ` +
            `Call await notion.initialize() at server start.`);
    }
    const resolved = dataSourceIdByDatabaseId.get(databaseId);
    if (!resolved) {
        throw new Error(`data_source_id not resolved for database ${databaseId}. ` +
            `Make sure it was passed to initializeDataSources() at startup.`);
    }
    return resolved;
}
/**
 * Test-only: lets tests reset the cache. Don't use from app code.
 */
export function _resetForTesting() {
    dataSourceIdByDatabaseId.clear();
    initialized = false;
}
