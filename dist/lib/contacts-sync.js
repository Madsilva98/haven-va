/**
 * The Google Contacts sync's decisions, as pure functions (tested in
 * test/contacts-sync.test.ts): who should be a contact, which existing
 * contact is theirs, and what each write looks like. No network here —
 * src/lib/google-contacts.ts talks to Google, src/crons/google-contacts-sync.ts
 * runs it.
 *
 * The status label itself is NOT decided here: it is the `status` column of
 * va.v_pulse_contact_status (scripts/studio-db-contact-status-2026-10-10.sql).
 * This file only knows the eight names, in the view's own order.
 */
export const CLIENTS_LABEL = "Haven clients";
/** The view's labels, in its first-match order (also the tie-break for a shared phone). */
export const STATUS_LABELS = [
    "Member",
    "Class pack",
    "Former member",
    "Idle intro pack",
    "Active intro pack",
    "Trying to convert",
    "Cold lead",
    "Lead",
];
/** clientData key that marks a Google contact as this member's. */
export const MEMBER_ID_KEY = "haven_member_id";
export function isContactStatus(value) {
    return typeof value === "string" && STATUS_LABELS.includes(value);
}
/**
 * "+<digits>" with a country code, or null when there is no usable number.
 * A 9-digit number is Portuguese: 351 goes in front. A leading 00 is the
 * international prefix, not part of the number.
 */
export function normalizePhone(raw) {
    let digits = (raw ?? "").replace(/\D/g, "");
    if (digits.startsWith("00"))
        digits = digits.slice(2);
    if (digits.length === 9)
        digits = `351${digits}`;
    // E.164: at most 15 digits; under 8 is not a full number.
    if (digits.length < 8 || digits.length > 15)
        return null;
    return `+${digits}`;
}
function cleanName(raw) {
    return (raw ?? "").replace(/\s+/g, " ").trim();
}
/**
 * One contact per phone number. Two accounts with the same number (the same
 * person with two emails, or a family sharing a phone: 17 numbers on
 * 2026-10-10) would be two Google contacts for one number, so the one with the
 * best status wins (the view's order), then the oldest account.
 */
export function desiredContacts(rows) {
    const skipped = { noPhone: 0, noName: 0, sharedPhone: 0, unknownStatus: [] };
    const byPhone = new Map();
    for (const row of rows) {
        const phone = normalizePhone(row.contact_phone);
        if (!phone) {
            skipped.noPhone++;
            continue;
        }
        if (!isContactStatus(row.status)) {
            skipped.unknownStatus.push(String(row.status));
            continue;
        }
        const name = cleanName(row.contact_name);
        if (!name) {
            skipped.noName++;
            continue;
        }
        const candidate = {
            contact: { memberId: row.member_id, name, phone, status: row.status },
            addedOn: row.added_on ?? "9999-12-31",
        };
        const current = byPhone.get(phone);
        if (!current) {
            byPhone.set(phone, candidate);
            continue;
        }
        skipped.sharedPhone++;
        if (compareForPhone(candidate, current) < 0)
            byPhone.set(phone, candidate);
    }
    const contacts = [...byPhone.values()].map((v) => v.contact).sort((a, b) => a.memberId.localeCompare(b.memberId));
    return { contacts, skipped };
}
function compareForPhone(a, b) {
    return (STATUS_LABELS.indexOf(a.contact.status) - STATUS_LABELS.indexOf(b.contact.status) ||
        a.addedOn.localeCompare(b.addedOn) ||
        a.contact.memberId.localeCompare(b.contact.memberId));
}
/** Reads a Google contact into what the diff compares. `statusByGroup`: status group resource name → label. */
export function toExistingContact(person, statusByGroup) {
    const name = person.names?.[0];
    const statuses = [];
    for (const m of person.memberships ?? []) {
        const status = statusByGroup.get(m.contactGroupMembership?.contactGroupResourceName ?? "");
        if (status && !statuses.includes(status))
            statuses.push(status);
    }
    return {
        resourceName: person.resourceName ?? "",
        memberIds: (person.clientData ?? [])
            .filter((d) => d.key === MEMBER_ID_KEY && d.value)
            .map((d) => d.value),
        name: cleanName(name?.unstructuredName ?? name?.displayName),
        phones: (person.phoneNumbers ?? [])
            .map((p) => normalizePhone(p.value))
            .filter((p) => p !== null),
        statuses,
        raw: person,
    };
}
/**
 * Diffs the "Haven clients" label against the view. A contact is matched by the
 * member_id stored in it, else by phone number (the 574 contacts imported by CSV
 * on 2026-10-10 carry no member_id; a changed email is a new member_id for the
 * same phone). Whatever is left in the label is removed.
 */
export function planSync(desired, existing) {
    const taken = new Set();
    const matches = new Map();
    const byMemberId = new Map();
    for (const e of existing)
        for (const id of e.memberIds)
            if (!byMemberId.has(id))
                byMemberId.set(id, e);
    for (const d of desired) {
        const e = byMemberId.get(d.memberId);
        if (e && !taken.has(e)) {
            matches.set(d, e);
            taken.add(e);
        }
    }
    let matchedByPhone = 0;
    for (const d of desired) {
        if (matches.has(d))
            continue;
        const e = existing.find((x) => !taken.has(x) && x.phones.includes(d.phone));
        if (e) {
            matches.set(d, e);
            taken.add(e);
            matchedByPhone++;
        }
    }
    const plan = { create: [], update: [], remove: [], unchanged: 0, matchedByPhone };
    for (const d of desired) {
        const e = matches.get(d);
        if (!e) {
            plan.create.push(d);
            continue;
        }
        const changes = diffContact(e, d);
        if (changes.length === 0)
            plan.unchanged++;
        else
            plan.update.push({ existing: e, desired: d, changes });
    }
    plan.remove = existing.filter((e) => !taken.has(e));
    return plan;
}
function diffContact(existing, desired) {
    const changes = [];
    if (existing.memberIds.length !== 1 || existing.memberIds[0] !== desired.memberId)
        changes.push("member_id");
    if (existing.name !== desired.name)
        changes.push("name");
    if (existing.phones.length !== 1 || existing.phones[0] !== desired.phone)
        changes.push("phone");
    if (existing.statuses.length !== 1 || existing.statuses[0] !== desired.status)
        changes.push("status");
    return changes;
}
function membership(group) {
    return { contactGroupMembership: { contactGroupResourceName: group } };
}
export function personForCreate(desired, groups) {
    return {
        names: [{ unstructuredName: desired.name }],
        phoneNumbers: [{ value: desired.phone, type: "mobile" }],
        memberships: [membership(groups.clients), membership(groups.status[desired.status])],
        clientData: [{ key: MEMBER_ID_KEY, value: desired.memberId }],
    };
}
/** The fields personForUpdate writes; everything else on the contact is left as it is. */
export const UPDATE_FIELDS = "names,phoneNumbers,memberships,clientData";
/**
 * The contact as it should be. Labels the sync does not own (myContacts, any
 * label a person added by hand) and other apps' clientData are kept.
 */
export function personForUpdate(existing, desired, groups) {
    const owned = new Set([groups.clients, ...Object.values(groups.status)]);
    const kept = (existing.raw.memberships ?? [])
        .map((m) => m.contactGroupMembership?.contactGroupResourceName)
        .filter((g) => Boolean(g) && !owned.has(g));
    return {
        resourceName: existing.resourceName,
        etag: existing.raw.etag,
        names: [{ unstructuredName: desired.name }],
        phoneNumbers: [{ value: desired.phone, type: "mobile" }],
        memberships: [...kept, groups.clients, groups.status[desired.status]].map(membership),
        clientData: [
            ...(existing.raw.clientData ?? [])
                .filter((d) => d.key !== MEMBER_ID_KEY)
                .map((d) => ({ key: d.key, value: d.value })),
            { key: MEMBER_ID_KEY, value: desired.memberId },
        ],
    };
}
