import "./helpers/notion-env.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const update = vi.fn().mockResolvedValue({});

vi.mock("@notionhq/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@notionhq/client")>();
  class Client {
    dataSources = { query: (...a: unknown[]) => query(...a) };
    pages = { update: (...a: unknown[]) => update(...a) };
  }
  return { ...actual, Client };
});

vi.mock("../src/lib/data-source-resolver.js", () => ({
  dsId: () => "ds_backlog",
  initializeDataSources: vi.fn(),
}));

import { syncCompletionDates } from "../src/notion.js";

type Filter = { and: Array<Record<string, unknown>> };
const isStampQuery = (args: { filter: Filter }) =>
  args.filter.and.some((f) => (f.select as { equals?: string } | undefined)?.equals === "Feito");

describe("syncCompletionDates", () => {
  afterEach(() => {
    query.mockReset();
    update.mockClear();
  });

  it("stamps newly Feito tasks with their last edit time and clears reopened ones", async () => {
    query.mockImplementation(async (args: { filter: Filter }) =>
      isStampQuery(args)
        ? { results: [{ id: "done1", last_edited_time: "2026-09-29T10:15:00.000Z", properties: {} }], has_more: false }
        : { results: [{ id: "reopened1", last_edited_time: "2026-09-30T09:00:00.000Z", properties: {} }], has_more: false },
    );

    const res = await syncCompletionDates();

    expect(res).toEqual({ stamped: 1, cleared: 1 });
    expect(update).toHaveBeenCalledWith({
      page_id: "done1",
      properties: { "Concluído em": { date: { start: "2026-09-29T10:15:00.000Z" } } },
    });
    expect(update).toHaveBeenCalledWith({
      page_id: "reopened1",
      properties: { "Concluído em": { date: null } },
    });
  });

  it("only picks Feito tasks without a date, and dated tasks that are no longer Feito", async () => {
    query.mockResolvedValue({ results: [], has_more: false });

    await syncCompletionDates();

    const filters = query.mock.calls.map((c) => (c[0] as { filter: Filter }).filter.and);
    expect(filters).toContainEqual([
      { property: "Status", select: { equals: "Feito" } },
      { property: "Concluído em", date: { is_empty: true } },
    ]);
    expect(filters).toContainEqual([
      { property: "Concluído em", date: { is_not_empty: true } },
      { property: "Status", select: { does_not_equal: "Feito" } },
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("follows pagination", async () => {
    let stampPage = 0;
    query.mockImplementation(async (args: { filter: Filter }) => {
      if (!isStampQuery(args)) return { results: [], has_more: false };
      stampPage++;
      return stampPage === 1
        ? { results: [{ id: "a", last_edited_time: "2026-09-28T08:00:00.000Z", properties: {} }], has_more: true, next_cursor: "c2" }
        : { results: [{ id: "b", last_edited_time: "2026-09-28T09:00:00.000Z", properties: {} }], has_more: false };
    });

    const res = await syncCompletionDates();

    expect(res.stamped).toBe(2);
  });
});
