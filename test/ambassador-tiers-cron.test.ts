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
  fetchAmbassadorTierMonthly: vi.fn(async (): Promise<unknown[]> => []),
  fetchAmbassadorReferrals: vi.fn(async (): Promise<unknown[]> => []),
  fetchAmbassadorTierToday: vi.fn(async (): Promise<unknown[] | null> => null),
  fetchAmbassadorTierScale: vi.fn(async (): Promise<unknown[] | null> => null),
  fetchMembershipStatusAsOf: vi.fn(async (): Promise<unknown[]> => []),
  fetchMemberIdentity: vi.fn(async () => [
    { member_id: "ana", contact_name: "Ana Silva" },
    { member_id: "rita", contact_name: "Rita Costa" },
  ]),
}));
vi.mock("../src/lib/pulse-views.js", () => ({
  ...views,
  PULSE_VIEW: {
    ambassadorTierMonthly: "v_pulse_ambassador_tier_monthly",
    ambassadorReferrals: "v_pulse_ambassador_referrals",
  },
}));
vi.mock("../src/lib/studio-db.js", () => ({ isStudioDbAvailable: () => true }));

const notion = vi.hoisted(() => ({
  getAllAmbassadorRows: vi.fn(async (): Promise<{ id: string; memberId: string; nome: string }[]> => []),
  createAmbassadorRow: vi.fn(async () => "page-1"),
  updateAmbassadorRow: vi.fn(async () => undefined),
}));
vi.mock("../src/notion.js", () => notion);

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

import { previousMonthStart, referredSummary, run } from "../src/crons/ambassador-tiers.js";

const tierRow = (id: string, month: string, tier: number, active: number) => ({
  month_start: month,
  ambassador_member_id: id,
  ambassador_is_member: true,
  active_referred: active,
  tier,
  is_first_five: false,
  discount_label: ["—", "10%", "15%", "50%"][tier],
  referred_member_ids: [],
});
const ref = (amb: string, referred: string, counts = true) => ({
  ambassador_member_id: amb,
  referred_member_id: referred,
  referred_on: "2026-10-20",
  is_new: true,
  first_membership_on: "2026-10-20",
  active_on_data_as_of: counts,
  excluded_reason: null,
});
const at = (iso: string) => new Date(`${iso}T08:25:00Z`);
const liveState = () => JSON.parse(files.get("ambassador-tiers-state.json") ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  files.clear();
  order.length = 0;
  vi.clearAllMocks();
  views.fetchAmbassadorTierMonthly.mockResolvedValue([]);
  views.fetchAmbassadorReferrals.mockResolvedValue([]);
  views.fetchAmbassadorTierToday.mockResolvedValue(null);
  views.fetchAmbassadorTierScale.mockResolvedValue(null);
  views.fetchMembershipStatusAsOf.mockResolvedValue([{ member_id: "ana", status: "Active", covers: true }]);
  notion.getAllAmbassadorRows.mockResolvedValue([]);
  delete process.env.AMBASSADOR_TIERS_DRY_RUN;
  delete process.env.AMBASSADOR_TIERS_FORCE;
  process.env.NOTION_AMBASSADORS_DB_ID = "db";
});

describe("ambassador-tiers cron", () => {
  it("previousMonthStart wraps the year", () => {
    expect(previousMonthStart("2027-01-01")).toBe("2026-12-01");
    expect(previousMonthStart("2026-11-01")).toBe("2026-10-01");
  });

  it("first import: a silent baseline that still fills Notion", async () => {
    views.fetchDataAsOf.mockResolvedValue("2026-10-20");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "rita")]);
    await run(at("2026-10-20"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(notion.createAmbassadorRow).toHaveBeenCalledWith(
      "Ana Silva",
      "ana",
      expect.objectContaining({ pessoasAtivas: 1, descontoEmVigor: null, pessoasReferidas: "Rita Costa — conta" }),
    );
    expect(liveState().lastAsOf).toBe("2026-10-20");
  });

  it("no new import: refreshes Notion only — no message, state untouched", async () => {
    const state = JSON.stringify({ lastAsOf: "2026-10-20", snapshot: {} });
    files.set("ambassador-tiers-state.json", state);
    notion.getAllAmbassadorRows.mockResolvedValue([{ id: "page-ana", memberId: "ana", nome: "Ana Silva" }]);
    views.fetchDataAsOf.mockResolvedValue("2026-10-20");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "rita")]);
    views.fetchAmbassadorTierToday.mockResolvedValue([
      { ...tierRow("ana", "2026-10-20", 1, 1), data_as_of: "2026-10-20", discount_in_kenko: "10%" },
    ]);
    await run(at("2026-10-21"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(files.get("ambassador-tiers-state.json")).toBe(state);
    expect(notion.updateAmbassadorRow).toHaveBeenCalledWith(
      "page-ana",
      "Ana Silva",
      expect.objectContaining({ descontoNoKenko: "10%", acaoKenko: "Outra origem" }),
    );
  });

  it("before the first import was ever seen: nothing at all", async () => {
    files.set("ambassador-tiers-state.json", JSON.stringify({ lastAsOf: "2026-10-20", snapshot: null }));
    views.fetchDataAsOf.mockResolvedValue("2026-10-20");
    await run(at("2026-10-21"));
    expect(notion.updateAmbassadorRow).not.toHaveBeenCalled();
    expect(notion.createAmbassadorRow).not.toHaveBeenCalled();
  });

  it("someone enters on a new import: one message, state saved before sending, Notion updated", async () => {
    files.set(
      "ambassador-tiers-state.json",
      JSON.stringify({
        lastAsOf: "2026-10-20",
        snapshot: { ana: { counting: [], cancelScheduled: [], selfMember: true, selfCancelScheduled: false } },
      }),
    );
    notion.getAllAmbassadorRows.mockResolvedValue([{ id: "page-ana", memberId: "ana", nome: "Ana Silva" }]);
    views.fetchDataAsOf.mockResolvedValue("2026-10-24");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "rita")]);
    await run(at("2026-10-24"));
    const [text, srcViews, asOf] = sendGroupMessageWithSource.mock.calls[0]!;
    expect(text).toContain("O que mudou\n· Ana Silva: entrou Rita Costa → 1 pessoa.\n\nA fazer");
    expect(text).toContain("A fazer\n· Avisar Ana Silva: entrou Rita Costa");
    expect(srcViews).toEqual(["v_pulse_ambassador_referrals"]);
    expect(asOf).toBe("2026-10-24");
    expect(order.slice(-2)).toEqual(["save", "send"]);
    expect(notion.updateAmbassadorRow).toHaveBeenCalledWith("page-ana", "Ana Silva", expect.objectContaining({ pessoasAtivas: 1 }));
  });

  it("warns Madalena once from the 5th that the import is late", async () => {
    files.set("ambassador-tiers-state.json", JSON.stringify({ lastAsOf: "2026-10-30", snapshot: {} }));
    views.fetchDataAsOf.mockResolvedValue("2026-10-30");
    await run(at("2026-11-05"));
    await run(at("2026-11-06"));
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(String(sendDM.mock.calls[0]![1])).toMatch(/não chegou a 1 de novembro \(dados até 30\/10\/2026\)/);
  });

  it("the first import covering the 1st carries the count, once", async () => {
    files.set(
      "ambassador-tiers-state.json",
      JSON.stringify({
        lastAsOf: "2026-10-30",
        snapshot: { ana: { counting: ["rita"], cancelScheduled: [], selfMember: true, selfCancelScheduled: false } },
      }),
    );
    views.fetchDataAsOf.mockResolvedValue("2026-11-02");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "rita")]);
    views.fetchAmbassadorTierMonthly.mockResolvedValue([tierRow("ana", "2026-11-01", 1, 1)]);
    await run(at("2026-11-02"));
    const [text, srcViews] = sendGroupMessageWithSource.mock.calls[0]!;
    expect(text).toContain("Contagem de 1 de novembro\nNovos\n· Ana Silva: 10% (1 pessoa)");
    expect(text).toContain("· Mudar no Kenko, no próximo pagamento: Ana Silva sem desconto → 10%");
    expect(text).not.toContain("O que mudou");
    expect(srcViews).toEqual(["v_pulse_ambassador_referrals", "v_pulse_ambassador_tier_monthly"]);
    expect(liveState().lastPostedMonth).toBe("2026-11-01");

    views.fetchDataAsOf.mockResolvedValue("2026-11-04");
    await run(at("2026-11-04"));
    expect(sendGroupMessageWithSource).toHaveBeenCalledTimes(1);
  });

  it("dry run: logs, posts and writes nothing live, keeps its own state", async () => {
    process.env.AMBASSADOR_TIERS_DRY_RUN = "true";
    views.fetchDataAsOf.mockResolvedValue("2026-10-20");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "rita")]);
    await run(at("2026-10-20"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(notion.createAmbassadorRow).not.toHaveBeenCalled();
    expect(files.has("ambassador-tiers-state.json")).toBe(false);
    expect(files.has("ambassador-tiers-state.dry-run.json")).toBe(true);
  });

  it("circuit breaker: most people leaving at once posts and writes nothing, warns once", async () => {
    const counting = ["a", "b", "c", "d", "e"];
    files.set(
      "ambassador-tiers-state.json",
      JSON.stringify({ lastAsOf: "2026-10-20", snapshot: { ana: { counting, cancelScheduled: [], selfMember: true, selfCancelScheduled: false } } }),
    );
    views.fetchDataAsOf.mockResolvedValue("2026-10-24");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "a")]);
    await run(at("2026-10-24"));
    await run(at("2026-10-25"));
    expect(sendGroupMessageWithSource).not.toHaveBeenCalled();
    expect(notion.updateAmbassadorRow).not.toHaveBeenCalled();
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(String(sendDM.mock.calls[0]![1])).toMatch(/4 das 5 pessoas/);
    expect(liveState().lastAsOf).toBe("2026-10-20");
  });

  it("AMBASSADOR_TIERS_FORCE lets the stopped run through", async () => {
    process.env.AMBASSADOR_TIERS_FORCE = "true";
    files.set(
      "ambassador-tiers-state.json",
      JSON.stringify({ lastAsOf: "2026-10-20", snapshot: { ana: { counting: ["a", "b", "c", "d", "e"], cancelScheduled: [], selfMember: true, selfCancelScheduled: false } } }),
    );
    views.fetchDataAsOf.mockResolvedValue("2026-10-24");
    views.fetchAmbassadorReferrals.mockResolvedValue([ref("ana", "a")]);
    await run(at("2026-10-24"));
    expect(String(sendGroupMessageWithSource.mock.calls[0]![0])).toContain("saíram");
  });
});

describe("referredSummary", () => {
  it("counting people first, then the rest with why", () => {
    const statuses = new Map([
      ["rita", { member_id: "rita", status: "Cancelation scheduled", covers: true }],
      ["eva", { member_id: "eva", status: "Paused", covers: true }],
      ["marta", { member_id: "marta", status: "Canceled", covers: false }],
    ]);
    const names = new Map([["rita", "Rita Costa"], ["eva", "Eva Matos"], ["marta", "Marta Dias"], ["joana", "Joana Reis"]]);
    const text = referredSummary(
      [
        { ...ref("ana", "joana", false), excluded_reason: "no_purchase" },
        ref("ana", "marta", false),
        ref("ana", "eva", false),
        ref("ana", "rita"),
      ],
      statuses,
      names,
    );
    expect(text).toBe(
      ["Rita Costa — conta, cancelamento agendado", "Eva Matos — em pausa", "Joana Reis — ainda sem compra", "Marta Dias — cancelou"].join("\n"),
    );
  });
});
