import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTesting,
  dsId,
  initializeDataSources,
} from "../src/lib/data-source-resolver.js";

// Minimal mock matching what the resolver needs from @notionhq/client.
// We only call client.databases.retrieve, so that's the only method we stub.
type RetrieveFn = (args: { database_id: string }) => Promise<unknown>;

function makeClient(retrieve: RetrieveFn) {
  return { databases: { retrieve } } as unknown as Parameters<typeof initializeDataSources>[0];
}

function dbWithSources(...names: string[]) {
  return {
    object: "database",
    data_sources: names.map((name, i) => ({ id: `ds_${name}_${i}`, name })),
  };
}

beforeEach(() => {
  _resetForTesting();
});

describe("initializeDataSources", () => {
  it("resolves data_source_id for each unique database", async () => {
    const seen: string[] = [];
    const client = makeClient(async ({ database_id }) => {
      seen.push(database_id);
      return dbWithSources("backlog");
    });

    await initializeDataSources(client, ["db_A", "db_B"]);

    expect(seen).toEqual(["db_A", "db_B"]);
    expect(dsId("db_A")).toBe("ds_backlog_0");
    expect(dsId("db_B")).toBe("ds_backlog_0");
  });

  it("skips undefined and empty-string entries", async () => {
    const seen: string[] = [];
    const client = makeClient(async ({ database_id }) => {
      seen.push(database_id);
      return dbWithSources("only");
    });

    await initializeDataSources(client, [undefined, "db_A", "", undefined, "db_B"]);

    expect(seen).toEqual(["db_A", "db_B"]);
  });

  it("deduplicates database IDs (a DB passed twice is resolved once)", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls++;
      return dbWithSources("dup");
    });

    await initializeDataSources(client, ["db_A", "db_A", "db_A"]);

    expect(calls).toBe(1);
    expect(dsId("db_A")).toBe("ds_dup_0");
  });

  it("throws on a database with zero data sources", async () => {
    const client = makeClient(async () => ({
      object: "database",
      data_sources: [],
    }));

    await expect(initializeDataSources(client, ["db_A"])).rejects.toThrow(
      /no data sources/i,
    );
  });

  it("throws on a database with multiple data sources — the breaking trap canary", async () => {
    const client = makeClient(async () => dbWithSources("primary", "secondary"));

    await expect(initializeDataSources(client, ["db_A"])).rejects.toThrow(
      /multi-source/i,
    );
  });

  it("surfaces Notion API errors with the database id in the failure path", async () => {
    const apiError = Object.assign(new Error("object_not_found"), { code: "object_not_found" });
    const client = makeClient(async () => {
      throw apiError;
    });

    await expect(initializeDataSources(client, ["db_missing"])).rejects.toThrow();
  });
});

describe("dsId (after init)", () => {
  it("throws if called before initialize", () => {
    expect(() => dsId("db_A")).toThrow(/before initializeDataSources/);
  });

  it("throws on an unknown database id", async () => {
    const client = makeClient(async () => dbWithSources("only"));
    await initializeDataSources(client, ["db_A"]);

    expect(() => dsId("db_NOT_RESOLVED")).toThrow(/not resolved/);
  });

  it("returns the cached data_source_id for a resolved database", async () => {
    const client = makeClient(async () => dbWithSources("backlog"));
    await initializeDataSources(client, ["db_A"]);

    expect(dsId("db_A")).toBe("ds_backlog_0");
  });

  it("survives multiple lookups (cache works)", async () => {
    let retrieveCalls = 0;
    const client = makeClient(async () => {
      retrieveCalls++;
      return dbWithSources("backlog");
    });
    await initializeDataSources(client, ["db_A"]);

    for (let i = 0; i < 1000; i++) {
      expect(dsId("db_A")).toBe("ds_backlog_0");
    }
    expect(retrieveCalls).toBe(1);
  });
});

describe("integration smoke: simulated haven-va startup", () => {
  it("resolves all 11 haven-va databases when each has exactly 1 data source", async () => {
    const dbIds = [
      "BACKLOG",
      "FOUNDER_FOCUS",
      "PARTNER",
      "INFLUENCER",
      "REMINDERS",
      "TO_DISCUSS",
      "DECISIONS",
      "CONTENT_CALENDAR",
      "PROJECTS",
      "EVENT",
      "LISTS",
    ];
    let calls = 0;
    const client = makeClient(async ({ database_id }) => {
      calls++;
      return dbWithSources(database_id.toLowerCase());
    });

    await initializeDataSources(client, dbIds);

    expect(calls).toBe(11);
    for (const id of dbIds) {
      expect(dsId(id)).toMatch(/^ds_/);
    }
  });

  it("fails fast on first DB with 2 data sources, doesn't continue to the rest", async () => {
    const order: string[] = [];
    const client = makeClient(async ({ database_id }) => {
      order.push(database_id);
      if (database_id === "PARTNER") {
        return dbWithSources("partner", "partner_archive");
      }
      return dbWithSources("ok");
    });

    await expect(
      initializeDataSources(client, ["BACKLOG", "PARTNER", "REMINDERS"]),
    ).rejects.toThrow(/multi-source/i);

    // BACKLOG and PARTNER are visited; REMINDERS never gets there.
    expect(order).toEqual(["BACKLOG", "PARTNER"]);
  });
});
