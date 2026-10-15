import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const order: string[] = [];
vi.mock("node:fs", () => ({
  default: {
    readFileSync: (p: string) => {
      const v = files.get(String(p));
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, data: string) => {
      order.push("save");
      files.set(String(p), data);
    },
    mkdirSync: () => undefined,
  },
}));

const views = vi.hoisted(() => ({
  fetchDataAsOf: vi.fn(),
  fetchAmbassadorTierMonthly: vi.fn(),
  fetchMemberIdentity: vi.fn(async () => [{ member_id: "ana", contact_name: "Ana Silva" }]),
}));
vi.mock("../src/lib/pulse-views.js", () => ({
  ...views,
  PULSE_VIEW: { ambassadorTierMonthly: "v_pulse_ambassador_tier_monthly" },
}));
vi.mock("../src/lib/studio-db.js", () => ({ isStudioDbAvailable: () => true }));

const sendGroupMessageWithSource = vi.fn(async (..._args: unknown[]) => {
  order.push("send");
  return 1;
});
vi.mock("../src/lib/pulse-source.js", () => ({
  sendGroupMessageWithSource: (...args: unknown[]) => sendGroupMessageWithSource(...args),
}));
const sendDM = vi.fn(async (..._args: unknown[]) => 1);
vi.mock("../src/lib/telegram.js", () => ({
  sendDM: (...args: unknown[]) => sendDM(...args),
  sendGroupMessage: vi.fn(async () => 1),
}));
vi.mock("../src/lib/founders.js", () => ({ getTelegramId: () => 111 }));

import { previousMonthStart, run } from "../src/crons/ambassador-tiers.js";

const row = (id: string, month: string, tier: number, active: number) => ({
  month_start: month,
  ambassador_member_id: id,
  ambassador_is_member: true,
  active_referred: active,
  tier,
  is_first_five: false,
  discount_label: ["—", "10%", "15%", "50%"][tier],
  referred_member_ids: [],
});
const at = (iso: string) => new Date(`${iso}T08:25:00Z`);
const state = () => JSON.parse([...files.values()][0] ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  files.clear();
  order.length = 0;
  vi.clearAllMocks();
  delete process.env.AMBASSADOR_TIERS_DRY_RUN;
  delete process.env.AMBASSADOR_TIERS_FORCE;
});

describe("ambassador-tiers cron", () => {
  it("previousMonthStart wraps the year", () => {
    expect(previousMonthStart("2027-01-01")).toBe("2026-12-01");
    expect(previousMonthStart("2026-11-01")).toBe("2026-10-01");
  });

  it("waits while data_as_of is before the 1st, silently until the 5th", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-10-30");
    await run(at("2026-11-03"));
    expect(views.fetchAmbassadorTierMonthly).not.toHaveBeenCalled();
    expect(sendDM).not.toHaveBeenCalled();
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
  });

  it("warns Madalena once from the 5th that the import is late", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-10-30");
    await run(at("2026-11-05"));
    await run(at("2026-11-06"));
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(String(sendDM.mock.calls[0]![1])).toMatch(/não chegou a 1 de novembro \(dados até 30\/10\/2026\)/);
  });

  it("posts the first count once, saving the month before sending", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-11-02");
    views.fetchAmbassadorTierMonthly.mockResolvedValue([row("ana", "2026-11-01", 2, 3)]);
    await run(at("2026-11-02"));
    await run(at("2026-11-03"));
    expect(sendGroupMessageWithSource).toHaveBeenCalledTimes(1);
    const [text, srcViews, asOf] = sendGroupMessageWithSource.mock.calls[0]!;
    expect(text).toContain("Novos\n· Ana Silva: 15% (3 pessoas)");
    expect(srcViews).toEqual(["v_pulse_ambassador_tier_monthly"]);
    expect(asOf).toBe("2026-11-02");
    expect(order).toEqual(["save", "send"]);
    expect(state().lastPostedMonth).toBe("2026-11-01");
  });

  it("does nothing before the first count exists", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-10-15");
    views.fetchAmbassadorTierMonthly.mockResolvedValue([]);
    await run(at("2026-10-15"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("no change: silent, but the month counts as done", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-12-01");
    views.fetchAmbassadorTierMonthly.mockResolvedValue([row("ana", "2026-11-01", 2, 2), row("ana", "2026-12-01", 2, 3)]);
    await run(at("2026-12-01"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(state().lastPostedMonth).toBe("2026-12-01");
  });

  it("dry run logs instead of posting and saves nothing", async () => {
    process.env.AMBASSADOR_TIERS_DRY_RUN = "true";
    views.fetchDataAsOf.mockResolvedValue("2026-11-02");
    views.fetchAmbassadorTierMonthly.mockResolvedValue([row("ana", "2026-11-01", 1, 1)]);
    await run(at("2026-11-02"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("circuit breaker: an empty month after a tiered one posts nothing and warns once", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-12-02");
    views.fetchAmbassadorTierMonthly.mockResolvedValue([row("ana", "2026-11-01", 2, 2)]);
    await run(at("2026-12-02"));
    await run(at("2026-12-03"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(String(sendDM.mock.calls[0]![1])).toMatch(/não publiquei/);
    expect(state().lastPostedMonth).toBeNull();
  });

  it("AMBASSADOR_TIERS_FORCE lets the stopped run through", async () => {
    process.env.AMBASSADOR_TIERS_FORCE = "true";
    views.fetchDataAsOf.mockResolvedValue("2026-12-02");
    views.fetchAmbassadorTierMonthly.mockResolvedValue([row("ana", "2026-11-01", 2, 2)]);
    await run(at("2026-12-02"));
    expect(String(sendGroupMessageWithSource.mock.calls[0]![0])).toContain("Deixam de ter desconto");
  });
});
