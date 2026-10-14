import { describe, expect, it } from "vitest";

import {
  MEMBER_ID_KEY,
  desiredContacts,
  normalizePhone,
  personForCreate,
  personForUpdate,
  planSync,
  toExistingContact,
  type ContactStatus,
  type DesiredContact,
  type LabelGroups,
} from "../src/lib/contacts-sync.js";

const GROUPS: LabelGroups = {
  clients: "contactGroups/clients",
  status: {
    Member: "contactGroups/member",
    "Class pack": "contactGroups/pack",
    "Former member": "contactGroups/former",
    "Idle intro pack": "contactGroups/idle",
    "Active intro pack": "contactGroups/intro",
    "Trying to convert": "contactGroups/convert",
    "Cold lead": "contactGroups/cold",
    Lead: "contactGroups/lead",
  },
};
const STATUS_BY_GROUP = new Map(Object.entries(GROUPS.status).map(([s, g]) => [g, s as ContactStatus]));

function row(member_id: string, contact_name: string, contact_phone: string | null, status: string | null, added_on = "2026-03-01") {
  return { member_id, contact_name, contact_phone, status, added_on };
}

function person(opts: { rn: string; name: string; phones: string[]; memberId?: string; status?: ContactStatus; extraGroups?: string[] }) {
  const groups = [GROUPS.clients, ...(opts.status ? [GROUPS.status[opts.status]] : []), ...(opts.extraGroups ?? [])];
  return {
    resourceName: opts.rn,
    etag: `etag-${opts.rn}`,
    names: [{ unstructuredName: opts.name, displayName: opts.name }],
    phoneNumbers: opts.phones.map((value) => ({ value })),
    memberships: groups.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } })),
    clientData: opts.memberId ? [{ key: MEMBER_ID_KEY, value: opts.memberId }] : [],
  };
}
const existing = (opts: Parameters<typeof person>[0]) => toExistingContact(person(opts), STATUS_BY_GROUP);

const ANA: DesiredContact = { memberId: "m-ana", name: "Ana Silva", phone: "+351912345678", status: "Member" };

describe("normalizePhone", () => {
  it("writes +<digits>, whatever the punctuation", () => {
    expect(normalizePhone("351 912 345 678")).toBe("+351912345678");
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
  });
  it("puts 351 in front of a 9-digit number", () => {
    expect(normalizePhone("912345678")).toBe("+351912345678");
  });
  it("drops the 00 international prefix", () => {
    expect(normalizePhone("00351912345678")).toBe("+351912345678");
  });
  it("has no number for an empty, text-only or impossible value", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("n/a")).toBeNull();
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("1234567890123456")).toBeNull();
  });
});

describe("desiredContacts", () => {
  it("keeps people with a phone only", () => {
    const { contacts, skipped } = desiredContacts([
      row("m1", "Ana  Silva ", "912345678", "Member"),
      row("m2", "Rui", null, "Lead"),
      row("m3", "Eva", "-", "Lead"),
    ]);
    expect(contacts).toEqual([{ memberId: "m1", name: "Ana Silva", phone: "+351912345678", status: "Member" }]);
    expect(skipped.noPhone).toBe(2);
  });

  it("makes one contact for a shared phone: the best status wins, then the oldest account", () => {
    const { contacts, skipped } = desiredContacts([
      row("m-lead", "Ana S.", "351912345678", "Lead", "2026-01-10"),
      row("m-member", "Ana Silva", "912 345 678", "Member", "2026-05-02"),
      row("m-cold-new", "Rui", "351930000000", "Cold lead", "2026-06-01"),
      row("m-cold-old", "Rui Costa", "351930000000", "Cold lead", "2026-02-01"),
    ]);
    expect(contacts.map((c) => c.memberId).sort()).toEqual(["m-cold-old", "m-member"]);
    expect(skipped.sharedPhone).toBe(2);
  });

  it("reports a status the view does not name instead of dropping the person silently", () => {
    const { contacts, skipped } = desiredContacts([
      row("m1", "Ana", "912345678", "Member"),
      row("m2", "Rui", "913333333", null),
      row("m3", "Eva", "914444444", "VIP"),
    ]);
    expect(contacts).toHaveLength(1);
    expect(skipped.unknownStatus).toEqual(["null", "VIP"]);
  });
});

describe("planSync", () => {
  it("leaves a contact that already matches alone", () => {
    const plan = planSync([ANA], [existing({ rn: "people/1", name: "Ana Silva", phones: ["+351 912 345 678"], memberId: "m-ana", status: "Member" })]);
    expect(plan).toMatchObject({ create: [], update: [], remove: [], unchanged: 1, matchedByPhone: 0 });
  });

  it("adopts a CSV-imported contact by phone on the first run and stamps the member_id and status on it", () => {
    const plan = planSync([ANA], [existing({ rn: "people/1", name: "Ana Silva", phones: ["912345678"] })]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.matchedByPhone).toBe(1);
    expect(plan.update[0].changes).toEqual(["member_id", "status"]);
  });

  it("updates a changed name, number and status on the contact with that member_id", () => {
    const plan = planSync(
      [{ ...ANA, name: "Ana Silva Costa", phone: "+351960000000", status: "Former member" }],
      [existing({ rn: "people/1", name: "Ana Silva", phones: ["+351912345678"], memberId: "m-ana", status: "Member" })],
    );
    expect(plan.update[0].changes).toEqual(["name", "phone", "status"]);
    expect(plan.create).toEqual([]);
  });

  it("fixes a contact carrying two status labels", () => {
    const e = existing({ rn: "people/1", name: "Ana Silva", phones: ["+351912345678"], memberId: "m-ana", status: "Member", extraGroups: [GROUPS.status.Lead] });
    expect(planSync([ANA], [e]).update[0].changes).toEqual(["status"]);
  });

  it("creates who is new and removes who left the view", () => {
    const gone = existing({ rn: "people/9", name: "Old", phones: ["+351999999999"], memberId: "m-gone", status: "Lead" });
    const plan = planSync([ANA], [gone]);
    expect(plan.create).toEqual([ANA]);
    expect(plan.remove.map((e) => e.resourceName)).toEqual(["people/9"]);
  });

  it("keeps the same contact when the member_id changes for the same phone (a changed email)", () => {
    const plan = planSync([{ ...ANA, memberId: "m-ana-new" }], [existing({ rn: "people/1", name: "Ana Silva", phones: ["+351912345678"], memberId: "m-ana", status: "Member" })]);
    expect(plan.create).toEqual([]);
    expect(plan.remove).toEqual([]);
    expect(plan.update[0].changes).toEqual(["member_id"]);
  });

  it("removes a second copy of the same person", () => {
    const first = existing({ rn: "people/1", name: "Ana Silva", phones: ["+351912345678"], memberId: "m-ana", status: "Member" });
    const copy = existing({ rn: "people/2", name: "Ana Silva", phones: ["+351912345678"] });
    const plan = planSync([ANA], [first, copy]);
    expect(plan.unchanged).toBe(1);
    expect(plan.remove.map((e) => e.resourceName)).toEqual(["people/2"]);
  });
});

describe("the writes", () => {
  it("creates a contact with the clients label, one status label and the member_id", () => {
    expect(personForCreate(ANA, GROUPS)).toEqual({
      names: [{ unstructuredName: "Ana Silva" }],
      phoneNumbers: [{ value: "+351912345678", type: "mobile" }],
      memberships: [
        { contactGroupMembership: { contactGroupResourceName: GROUPS.clients } },
        { contactGroupMembership: { contactGroupResourceName: GROUPS.status.Member } },
      ],
      clientData: [{ key: MEMBER_ID_KEY, value: "m-ana" }],
    });
  });

  it("swaps the status label and keeps every label and client data it does not own", () => {
    const raw = person({ rn: "people/1", name: "Ana Silva", phones: ["+351912345678"], memberId: "m-old", status: "Lead", extraGroups: ["contactGroups/myContacts", "contactGroups/handmade"] });
    raw.clientData.push({ key: "other_app", value: "x" });
    const out = personForUpdate(toExistingContact(raw, STATUS_BY_GROUP), ANA, GROUPS);
    expect(out.resourceName).toBe("people/1");
    expect(out.etag).toBe("etag-people/1");
    expect(out.memberships?.map((m) => m.contactGroupMembership?.contactGroupResourceName)).toEqual([
      "contactGroups/myContacts",
      "contactGroups/handmade",
      GROUPS.clients,
      GROUPS.status.Member,
    ]);
    expect(out.clientData).toEqual([
      { key: "other_app", value: "x" },
      { key: MEMBER_ID_KEY, value: "m-ana" },
    ]);
  });
});
