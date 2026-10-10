import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
vi.mock("node:fs", () => ({
  default: {
    readFileSync: (p: string) => {
      const v = files.get(String(p));
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, data: string) => void files.set(String(p), data),
    mkdirSync: () => undefined,
  },
}));

const fetchContactSyncRows = vi.fn();
vi.mock("../src/lib/pulse-views.js", () => ({
  fetchContactSyncRows: () => fetchContactSyncRows(),
}));

const google = vi.hoisted(() => ({
  STUDIO_ACCOUNT: "studio@example.com",
  isAuthenticated: vi.fn(() => true),
  isAuthError: vi.fn((err: unknown) => /invalid_grant/.test(String(err))),
  listUserGroups: vi.fn(),
  listGroupContacts: vi.fn(),
  createGroup: vi.fn(async (name: string) => ({ name, resourceName: `contactGroups/new-${name}` })),
  createContacts: vi.fn(async (_persons: unknown[]) => undefined),
  updateContacts: vi.fn(async (_persons: unknown[], _fields: string) => undefined),
  deleteContacts: vi.fn(async (_resourceNames: string[]) => undefined),
}));
vi.mock("../src/lib/google-contacts.js", () => google);

const sendDM = vi.fn(async () => 1);
const sendGroupMessage = vi.fn(async () => 1);
vi.mock("../src/lib/telegram.js", () => ({
  sendDM: (...args: unknown[]) => sendDM(...(args as [])),
  sendGroupMessage: (...args: unknown[]) => sendGroupMessage(...(args as [])),
}));
vi.mock("../src/lib/founders.js", () => ({ getTelegramId: () => 111 }));

import { run } from "../src/crons/google-contacts-sync.js";
import { MEMBER_ID_KEY, STATUS_LABELS } from "../src/lib/contacts-sync.js";

const NOW = new Date("2026-10-11T06:30:00+01:00");
const ALL_GROUPS = [
  { name: "Haven clients", resourceName: "contactGroups/clients" },
  ...STATUS_LABELS.map((name) => ({ name, resourceName: `contactGroups/${name}` })),
];

function viewRow(i: number, status = "Lead") {
  return { member_id: `m${i}`, contact_name: `Pessoa ${i}`, contact_phone: `3519100000${String(i).padStart(2, "0")}`, added_on: "2026-03-01", status };
}
function contact(i: number, opts: { status?: string; memberId?: boolean } = {}) {
  const groups = ["contactGroups/clients", ...(opts.status ? [`contactGroups/${opts.status}`] : [])];
  return {
    resourceName: `people/${i}`,
    etag: `e${i}`,
    names: [{ unstructuredName: `Pessoa ${i}` }],
    phoneNumbers: [{ value: `+3519100000${String(i).padStart(2, "0")}` }],
    memberships: groups.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } })),
    clientData: opts.memberId ? [{ key: MEMBER_ID_KEY, value: `m${i}` }] : [],
  };
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const lastMessage = () => String(sendDM.mock.calls.at(-1)?.[1] ?? "");
const stateFile = () => JSON.parse([...files.values()][0] ?? "{}") as Record<string, unknown>;
const succeededBefore = () =>
  files.set("google-contacts-sync-state.json", JSON.stringify({ lastSuccessAt: "2026-10-10T05:30:00.000Z", consecutiveFailures: 0 }));

beforeEach(() => {
  files.clear();
  vi.clearAllMocks();
  google.isAuthenticated.mockReturnValue(true);
  google.listUserGroups.mockResolvedValue(ALL_GROUPS);
  delete process.env.GOOGLE_CONTACTS_FORCE;
  delete process.env.GOOGLE_CONTACTS_DRY_RUN;
});

describe("google-contacts-sync", () => {
  it("first run: adopts the imported contacts by phone, creates who is missing, and says so once", async () => {
    fetchContactSyncRows.mockResolvedValue(range(10).map((i) => viewRow(i)));
    google.listGroupContacts.mockResolvedValue(range(9).map((i) => contact(i)));

    await run(NOW);

    expect(google.createContacts.mock.calls[0][0]).toHaveLength(1);
    const [updates, fields] = google.updateContacts.mock.calls[0] as unknown as [Array<{ clientData: unknown }>, string];
    expect(updates).toHaveLength(9);
    expect(updates[0].clientData).toEqual([{ key: MEMBER_ID_KEY, value: "m1" }]);
    expect(fields).toBe("names,phoneNumbers,memberships,clientData");
    expect(google.deleteContacts).toHaveBeenCalledWith([]);
    expect(lastMessage()).toContain("9 reconhecidos pelo telefone");
    expect(stateFile().lastSuccessAt).toBe(NOW.toISOString());
  });

  it("a normal day: updates the one changed status, removes who left, stays silent", async () => {
    succeededBefore();
    fetchContactSyncRows.mockResolvedValue([viewRow(1, "Member"), ...range(19).map((i) => viewRow(i + 1))]);
    google.listGroupContacts.mockResolvedValue(range(21).map((i) => contact(i, { status: "Lead", memberId: true })));

    await run(NOW);

    expect(google.updateContacts.mock.calls[0][0]).toHaveLength(1);
    expect(google.deleteContacts).toHaveBeenCalledWith(["people/21"]);
    expect(google.createGroup).not.toHaveBeenCalled();
    expect(sendDM).not.toHaveBeenCalled();
  });

  it("creates the labels that are missing before writing contacts", async () => {
    succeededBefore();
    google.listUserGroups.mockResolvedValue([ALL_GROUPS[0]]);
    fetchContactSyncRows.mockResolvedValue([viewRow(1)]);
    google.listGroupContacts.mockResolvedValue([contact(1, { memberId: true })]);

    await run(NOW);

    expect(google.createGroup.mock.calls.map((c) => c[0])).toEqual([...STATUS_LABELS]);
    const [updates] = google.updateContacts.mock.calls[0] as unknown as [Array<{ memberships: Array<{ contactGroupMembership: { contactGroupResourceName: string } }> }>];
    expect(updates[0].memberships.map((m) => m.contactGroupMembership.contactGroupResourceName)).toEqual([
      "contactGroups/clients",
      "contactGroups/new-Lead",
    ]);
  });

  it("an expired or revoked login raises an alert that says to redo /authcontacts", async () => {
    succeededBefore();
    fetchContactSyncRows.mockResolvedValue([viewRow(1)]);
    google.listUserGroups.mockRejectedValue(new Error("invalid_grant"));

    await run(NOW);

    expect(lastMessage()).toContain("/authcontacts");
    expect(lastMessage()).toContain("10/10/2026");
    expect(stateFile()).toMatchObject({ consecutiveFailures: 1, lastError: "invalid_grant", lastSuccessAt: "2026-10-10T05:30:00.000Z" });
    expect(google.createContacts).not.toHaveBeenCalled();
  });

  it("a failed sync raises an alert, and the next good run says it is back", async () => {
    succeededBefore();
    fetchContactSyncRows.mockRejectedValueOnce(new Error('relation "v_pulse_contact_status" does not exist'));
    await run(NOW);
    expect(lastMessage()).toContain("falhou");
    expect(lastMessage()).toContain("v_pulse_contact_status");

    fetchContactSyncRows.mockResolvedValue([viewRow(1)]);
    google.listGroupContacts.mockResolvedValue([contact(1, { status: "Lead", memberId: true })]);
    await run(NOW);
    expect(lastMessage()).toContain("voltou a funcionar");
    expect(stateFile().consecutiveFailures).toBe(0);
  });

  it("stays quiet before /authcontacts was ever done", async () => {
    google.isAuthenticated.mockReturnValue(false);
    await run(NOW);
    expect(fetchContactSyncRows).not.toHaveBeenCalled();
    expect(sendDM).not.toHaveBeenCalled();
  });

  it("alerts when the login file disappears after it had been working", async () => {
    succeededBefore();
    google.isAuthenticated.mockReturnValue(false);
    fetchContactSyncRows.mockResolvedValue([viewRow(1)]);
    google.listUserGroups.mockRejectedValue(new Error("invalid_grant: not authenticated"));
    await run(NOW);
    expect(lastMessage()).toContain("/authcontacts");
  });

  describe("writes nothing when the run looks wrong", () => {
    const nothingWritten = () => {
      expect(google.createGroup).not.toHaveBeenCalled();
      expect(google.createContacts).not.toHaveBeenCalled();
      expect(google.updateContacts).not.toHaveBeenCalled();
      expect(google.deleteContacts).not.toHaveBeenCalled();
    };

    it("an empty view", async () => {
      succeededBefore();
      fetchContactSyncRows.mockResolvedValue([]);
      await run(NOW);
      nothingWritten();
      expect(lastMessage()).toContain("veio vazia");
    });

    it("a status the view does not name", async () => {
      succeededBefore();
      fetchContactSyncRows.mockResolvedValue([viewRow(1), viewRow(2, "VIP")]);
      await run(NOW);
      nothingWritten();
      expect(lastMessage()).toContain("VIP");
    });

    it("first run on an account without the imported contacts (the wrong Google account)", async () => {
      google.listUserGroups.mockResolvedValue([]);
      fetchContactSyncRows.mockResolvedValue(range(10).map((i) => viewRow(i)));
      await run(NOW);
      nothingWritten();
      expect(lastMessage()).toContain("studio@example.com");
      expect(google.listGroupContacts).not.toHaveBeenCalled();
    });

    it("a run that would remove a large share of the label", async () => {
      succeededBefore();
      fetchContactSyncRows.mockResolvedValue(range(30).map((i) => viewRow(i)));
      google.listGroupContacts.mockResolvedValue(range(45).map((i) => contact(i, { status: "Lead", memberId: true })));
      await run(NOW);
      nothingWritten();
      expect(lastMessage()).toContain("ia remover 15 dos 45");
    });

    it("a run that would create a large share of the list", async () => {
      succeededBefore();
      fetchContactSyncRows.mockResolvedValue(range(60).map((i) => viewRow(i)));
      google.listGroupContacts.mockResolvedValue(range(30).map((i) => contact(i, { status: "Lead", memberId: true })));
      await run(NOW);
      nothingWritten();
      expect(lastMessage()).toContain("ia criar 30");
    });

    it("unless GOOGLE_CONTACTS_FORCE lets it through", async () => {
      succeededBefore();
      process.env.GOOGLE_CONTACTS_FORCE = "true";
      fetchContactSyncRows.mockResolvedValue(range(30).map((i) => viewRow(i)));
      google.listGroupContacts.mockResolvedValue(range(45).map((i) => contact(i, { status: "Lead", memberId: true })));
      await run(NOW);
      expect(google.deleteContacts.mock.calls[0][0]).toHaveLength(15);
    });

    it("a dry run, which reports what it would do", async () => {
      process.env.GOOGLE_CONTACTS_DRY_RUN = "true";
      fetchContactSyncRows.mockResolvedValue(range(10).map((i) => viewRow(i)));
      google.listGroupContacts.mockResolvedValue(range(9).map((i) => contact(i)));
      await run(NOW);
      nothingWritten();
      expect(lastMessage()).toContain("simulação");
      expect(lastMessage()).toContain("1 criados, 9 atualizados, 0 removidos");
      expect(files.size).toBe(0);
    });
  });
});
