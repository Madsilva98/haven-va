# Pulse Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot reads studio numbers from `v_pulse_*` views (not raw `kenko_*` tables) wherever a view exists today, names its source view in every number it posts, answers "porquê?" with the view's COMMENT, and lets Madalena flag a wrong number from Telegram into `pulse_cases`.

**Architecture:** One new reader module (`src/lib/pulse-views.ts`) owns every view read plus the pure "as of the data date" roster logic; the three existing consumers (`churn-signals.ts`, `intro-pack-conversion.ts`, `birthdays.ts`) swap their roster/pack/conversion reads to it and keep only the seven allowlisted raw reads Mafalda is replacing with views. `pulse_cases.ts` + `pulse-source.ts` + `bot/pulse.ts` add the Telegram surface. A vitest guard pins the allowlist.

**Tech Stack:** TypeScript (ESM, Node 20), grammY, `@supabase/supabase-js` (service_role key), vitest.

**Spec:** `docs/plans/2026-09-21-pulse-views-spec.md` — read it first; the "Decisions" and "Facts established" sections are binding.

> **Revised mid-execution, 2026-09-21.** After Task 2 Mafalda shipped the studio side: schema `va` + Postgres role `haven_va` (no service key, no PostgREST) and the six gap views (`v_pulse_member_identity`, `v_pulse_member_activity`, `v_pulse_attendance_monthly`, `v_pulse_failed_payments`, `v_pulse_first_paid`, `v_pulse_utilization_monthly`). So the executed shape differs from Tasks 1–7 below in three ways: the access layer is `src/lib/studio-db.ts` (`pg`, `STUDIO_DATABASE_URL`) and `@supabase/supabase-js` is gone; "porquê?" reads `obj_description`/`col_description` over that connection, not the OpenAPI root; and every raw read was swapped in the same pass, so the allowlist is empty. The verification list at the end still holds. What shipped is described in `docs/knowledge-base/pulse-views.md`.

## Global Constraints

- Never `.from("kenko_…")` outside the seven allowlisted (file, table) pairs in `src/lib/kenko-allowlist.json`; the guard test (Task 8) enforces it.
- Never add a staff/test exclusion list to the bot: the views exclude staff. `isExcludedEmail` is deleted in Task 5.
- "Today" for the roster is **data-as-of** = `max(cycle_starts_at) <= today` over `v_pulse_membership_state`, never the calendar. Pass it as `now` into the churn signals too.
- `member_id` = `md5(lower(contact_email))` — **no trim** (matches the view SQL exactly).
- Attended = `checkin_status = 'Yes'` alone (already the case in `intro-pack-conversion.ts`; churn's Booked-only rule is signal-1 "last booking made", not attendance — leave it).
- All user-facing text pt-PT. Logs `log.info("dotted.label", { data })`.
- Do not touch the studio project's schema. Missing views → `pulse_cases` rows (already written, ids 15–19, Task 0).
- Commits: conventional, atomic, one per task, `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` trailer.
- Run `npm run typecheck && npm run test` before every commit.

---

### Task 0: Record the five view gaps in `pulse_cases` (no code)

**Files:** none (DB rows in the studio project, via the session's Management-API helper `scratchpad/sq.sh`).

- [ ] **Step 1: Insert the five rows**

```sql
insert into pulse_cases (raised_by, source, view_name, subject, observed, expected, evidence) values
('bot','session',null,
 'Identity view: member_id -> contact_name, contact_email, contact_phone, date_of_birth',
 'Every v_pulse_* view except v_pulse_paused_detail / v_pulse_pause_history / v_pulse_intro_purchase exposes only member_id = md5(lower(email)). The bot needs name + phone for Notion rows (Clientes em risco, Leads a contactar) and name + DOB for the birthday digest, so it still reads kenko_customers whole: select contact_name, contact_email, contact_phone from kenko_customers (src/lib/leads.ts:55) and select contact_name, contact_email, date_of_birth from kenko_customers where date_of_birth is not null (src/lib/birthdays.ts:101).',
 'A view, e.g. v_pulse_member_identity(member_id, contact_name, contact_email, contact_phone, date_of_birth), staff excluded like every other view, so the bot joins on member_id and never reads kenko_customers.',
 'Inventory 2026-09-21, rows 10 and 15 — docs/plans/2026-09-21-pulse-views-spec.md'),
('bot','session',null,
 'Attendance per member: last_visit, visit_count, last_booked',
 'The bot reads kenko_bookings whole twice: select contact_email, event_date, checkin_status from kenko_bookings where checkin_status = ''Yes'' (src/lib/intro-pack-conversion.ts:141 — last visit + count for the intro-pack Motivo text and the expiring digest''s "1 of 2 classes used" / ">5 classes used" rules) and select contact_email, booking_date, event_date, booking_status from kenko_bookings where booking_date >= now() - 4 months (src/lib/churn-signals.ts:343 — signal 1 "no Booked booking in 14+ days" and the monthly attended counts behind signal 3).',
 'A view, e.g. v_pulse_member_attendance(member_id, last_visit, visit_count, last_booked_on), attended = checkin_status = ''Yes'' alone (Roberta Dias rule, case #10), Lisbon dates, plus a monthly grain (member_id, month, attended) for utilization.',
 'Inventory 2026-09-21, rows 3 and 8 — docs/plans/2026-09-21-pulse-views-spec.md'),
('bot','session',null,
 'Failed payments per member in the last 45 days',
 'The bot reads select contact_email, payment_date from kenko_payments where payment_status = ''Failed'' and payment_date >= now() - 45 days (src/lib/churn-signals.ts:350) for churn signal 2 "Pagamento falhado".',
 'A view, e.g. v_pulse_failed_payments(member_id, payment_date), or a failed_payment_on column on a member-level churn view.',
 'Inventory 2026-09-21, row 4 — docs/plans/2026-09-21-pulse-views-spec.md'),
('bot','session',null,
 'Has this email ever paid? (first paid order per email)',
 'The bot answers hasRealPurchase(email) with two counts: kenko_payments where contact_email ilike $1 and payment_status = ''Paid'', OR kenko_sale_items where contact_email ilike $1 and sale_type = ''Purchase'' and total_sales > 0 (src/lib/leads.ts:94-99). Used by leads-reconcile to archive an Email/WhatsApp/Instagram lead the moment they buy anything, and by the (disabled) email scan to never write a paying customer as a lead.',
 'A view, e.g. v_pulse_first_paid_order(member_id, first_paid_on), using the same "paid" rule as v_pulse_new_customers_weekly so the bot and the dashboard agree on who is a customer.',
 'Inventory 2026-09-21, rows 11 and 12 — docs/plans/2026-09-21-pulse-views-spec.md'),
('bot','session',null,
 'Plan utilization per member-month (churn signal 3)',
 'The bot computes it itself: for each of the last 3 full calendar months, attended bookings (checkin Yes) / monthly allowance parsed from the plan name (4x -> 4, Unlimited -> skipped), skipping months before the member joined and months overlapping a paused/stretched cycle (src/lib/churn-signals.ts computeChurnFlags). Mafalda 2026-09-21: this goes in a view, one implementation, not in the bot.',
 'A view, e.g. v_pulse_member_utilization(member_id, month, attended, allowance, utilization_pct, is_partial) built on v_pulse_membership_state (tier -> allowance, member-since for win-backs) and v_pulse_pause_history, so the bot only reads "3 consecutive full months under 50%".',
 'Inventory 2026-09-21, row 5 of the gap list — docs/plans/2026-09-21-pulse-views-spec.md');
```

- [ ] **Step 2: Verify** — `select id, subject from v_pulse_known_cases where raised_by = 'bot' and status = 'open'` returns 5 rows; note their ids (they are 15–19) for the allowlist `case` field in Task 8.

---

### Task 1: `pulse-views.ts` — view reader + as-of roster logic

**Files:**
- Create: `src/lib/pulse-views.ts`
- Modify: `src/lib/tz.ts` (add `lisbonDateString`)
- Create: `test/pulse-views.test.ts`
- Create: `test/fixtures/v_pulse_membership_state.2026-09-18.json` (real snapshot, md5 ids only — no PII)

**Interfaces (produced):**
```ts
export const PULSE_VIEW: { membershipState: "v_pulse_membership_state"; pauseHistory: "v_pulse_pause_history"; introPurchase: "v_pulse_intro_purchase"; introConversion: "v_pulse_intro_conversion"; classpackState: "v_pulse_classpack_state"; introHolderState: "v_pulse_intro_holder_state"; knownCases: "v_pulse_known_cases" }
export function memberIdFromEmail(email: string): string
export interface MembershipStateRow { member_id: string; tier: string | null; plan: string | null; status: string | null; started: string | null; cycle_starts_at: string | null; cycle_expires_at: string | null; cycle_billing_ends_at: string | null; is_paying_cycle: boolean; is_paused: boolean; is_unpaid: boolean; churned_on: string | null; owes_dues: boolean }
export function computeDataAsOf(rows: Array<Pick<MembershipStateRow, "cycle_starts_at">>, today: string): string | null
export interface ActiveMember { memberId: string; tier: string; plan: string; membershipName: string; memberSince: string }
export function activeMembersAsOf(rows: MembershipStateRow[], asOf: string): Map<string, ActiveMember>
export function continuousSince(cycles: MembershipStateRow[], current: MembershipStateRow): string
export interface PauseHistoryRow { member_id: string; contact_name: string | null; contact_email: string | null; membership_name: string | null; cycle_start: string; cycle_end: string; membership_status: string | null; is_current: boolean; pause_days_est: number | null }
export interface IntroPurchaseRow { sale_id: number; email: string; member_id: string; item_name: string; pack: string; intro_purchase: string; kenko_start: string | null; intro_end: string; intro_end_source: "kenko" | "modeled"; is_open_day: boolean; is_valentine: boolean; is_for_members: boolean }
export interface IntroConversionRow { member_id: string; intro_date: string; intro_end: string; pack: string; converted: boolean; converted_pack: boolean; pack_type: string | null; tier: string | null; days_to_convert: number | null }
export interface PackWindowRow { member_id: string; started: string | null; expires: string | null; has_credits?: boolean }
export async function fetchMembershipState(): Promise<MembershipStateRow[]>
export async function fetchPauseHistory(): Promise<PauseHistoryRow[]>
export async function fetchIntroPurchases(): Promise<IntroPurchaseRow[]>
export async function fetchIntroConversion(): Promise<IntroConversionRow[]>
export async function fetchClasspackState(): Promise<PackWindowRow[]>
export async function fetchIntroHolderState(): Promise<PackWindowRow[]>
export function parseViewComment(openapi: unknown, view: string): string | null
export async function getViewComment(view: string): Promise<string | null>
// tz.ts
export function lisbonDateString(d: Date): string  // "YYYY-MM-DD" in Europe/Lisbon
```

- [ ] **Step 1: Pull the fixture (real rows, hashes only)**

```bash
S=/private/tmp/claude-501/-Users-mafaldasaudade-The-Haven-haven-va/ba9c1ab8-64f5-4538-bcf6-3dccc78b5f63/scratchpad
mkdir -p test/fixtures
jq -n --arg q "select * from v_pulse_membership_state order by member_id, cycle_starts_at" '{query:$q}' \
 | curl -s -X POST "https://api.supabase.com/v1/projects/leddqmselxsjamlvxvyk/database/query" \
   -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" -d @- \
 | jq '.' > test/fixtures/v_pulse_membership_state.2026-09-18.json
jq length test/fixtures/v_pulse_membership_state.2026-09-18.json   # expect 558
# member_ids for the assertions (hashes, not PII):
$S/sq.sh "select contact_name, md5(lower(contact_email)) mid from kenko_customers where contact_name in ('Esen Sekerkarar','Andreia taboleiros','Madalena Almeida')"
```

- [ ] **Step 2: Write the failing tests**

`test/pulse-views.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  activeMembersAsOf,
  computeDataAsOf,
  continuousSince,
  memberIdFromEmail,
  parseViewComment,
  type MembershipStateRow,
} from "../src/lib/pulse-views.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/v_pulse_membership_state.2026-09-18.json", import.meta.url), "utf8"),
) as MembershipStateRow[];

// Hashes only (member_id = md5(lower(email)) — the views' own key). Paste
// the values from Task 1 Step 1 here.
const ESEN = "<md5>";
const ANDREIA = "<md5>";
const MADALENA_ALMEIDA = "<md5>";

describe("memberIdFromEmail", () => {
  it("is md5(lower(email)) with no trim, matching the view SQL", () => {
    expect(memberIdFromEmail("Sofia@Example.com")).toBe(memberIdFromEmail("sofia@example.com"));
    expect(memberIdFromEmail(" a@b.c")).not.toBe(memberIdFromEmail("a@b.c"));
    expect(memberIdFromEmail("a@b.c")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("computeDataAsOf", () => {
  it("is the latest cycle start on or before today — 2026-09-18 on the pinned snapshot", () => {
    expect(computeDataAsOf(fixture, "2026-09-21")).toBe("2026-09-18");
  });
  it("ignores cycle starts after today (a pre-scheduled renewal is not data)", () => {
    expect(computeDataAsOf([{ cycle_starts_at: "2026-10-01" }, { cycle_starts_at: "2026-09-10" }], "2026-09-21")).toBe("2026-09-10");
  });
  it("returns null with no usable rows", () => {
    expect(computeDataAsOf([], "2026-09-21")).toBeNull();
  });
});

describe("activeMembersAsOf — the verification query from the spec", () => {
  const active = activeMembersAsOf(fixture, "2026-09-18");
  it("counts 75 paying members on 2026-09-18", () => {
    expect(active.size).toBe(75);
  });
  it("leaves Esen Sekerkarar out (paused 14-30 Sep, case #1)", () => {
    expect(active.has(ESEN)).toBe(false);
  });
  it("keeps Andreia taboleiros in (cancellation scheduled 9 Oct is still paying, case #5)", () => {
    expect(active.has(ANDREIA)).toBe(true);
  });
  it("never sees staff — Madalena Almeida is not in the view at all (case #11)", () => {
    expect(fixture.some((r) => r.member_id === MADALENA_ALMEIDA)).toBe(false);
  });
  it("labels the plan the way Notion rows already read it", () => {
    const one = [...active.values()][0];
    expect(one.membershipName).toMatch(/^(4x|8x|12x|Unlimited) Monthly \| (Premium|Essentials)$/);
  });
});

function cycle(memberId: string, start: string, end: string | null, extra: Partial<MembershipStateRow> = {}): MembershipStateRow {
  return {
    member_id: memberId, tier: "4x", plan: "Premium", status: "Active", started: start,
    cycle_starts_at: start, cycle_expires_at: end, cycle_billing_ends_at: end,
    is_paying_cycle: true, is_paused: false, is_unpaid: false, churned_on: null, owes_dues: false, ...extra,
  };
}

describe("continuousSince", () => {
  it("walks back over back-to-back cycles to the first one", () => {
    const cycles = [cycle("m", "2026-06-01", "2026-07-01"), cycle("m", "2026-07-01", "2026-08-01"), cycle("m", "2026-08-01", "2026-09-01")];
    expect(continuousSince(cycles, cycles[2])).toBe("2026-06-01");
  });
  it("stops at a gap wider than 3 days (a win-back restarts tenure)", () => {
    const cycles = [cycle("m", "2026-01-01", "2026-02-01"), cycle("m", "2026-08-15", "2026-09-15")];
    expect(continuousSince(cycles, cycles[1])).toBe("2026-08-15");
  });
  it("tolerates a 1-2 day billing gap", () => {
    const cycles = [cycle("m", "2026-07-01", "2026-07-31"), cycle("m", "2026-08-02", "2026-09-02")];
    expect(continuousSince(cycles, cycles[1])).toBe("2026-07-01");
  });
  it("ignores non-paying cycles when chaining", () => {
    const cycles = [cycle("m", "2026-06-01", "2026-07-01"), cycle("m", "2026-07-01", "2026-08-01", { is_paying_cycle: false, is_paused: true }), cycle("m", "2026-08-01", "2026-09-01")];
    // paused cycle breaks the paying chain: tenure restarts after the pause
    expect(continuousSince(cycles, cycles[2])).toBe("2026-08-01");
  });
});

describe("activeMembersAsOf edge cases", () => {
  it("is empty when no cycle overlaps asOf", () => {
    expect(activeMembersAsOf([cycle("m", "2026-01-01", "2026-02-01")], "2026-09-18").size).toBe(0);
  });
  it("treats a null cycle_expires_at as open-ended", () => {
    expect(activeMembersAsOf([cycle("m", "2026-09-01", null)], "2026-09-18").has("m")).toBe(true);
  });
  it("skips non-paying cycles even when they overlap", () => {
    expect(activeMembersAsOf([cycle("m", "2026-09-01", "2026-10-01", { is_paying_cycle: false, is_paused: true })], "2026-09-18").size).toBe(0);
  });
  it("is inclusive on both cycle bounds (a cycle ending today still counts — dedup-memberships gotcha)", () => {
    expect(activeMembersAsOf([cycle("m", "2026-08-18", "2026-09-18")], "2026-09-18").has("m")).toBe(true);
  });
});

describe("parseViewComment", () => {
  const doc = { definitions: { v_pulse_paused_detail: { description: "Members paused right now, one row each." }, v_pulse_membership_state: {} } };
  it("returns the COMMENT PostgREST publishes as the definition description", () => {
    expect(parseViewComment(doc, "v_pulse_paused_detail")).toBe("Members paused right now, one row each.");
  });
  it("returns null for a view with no comment or not in the document", () => {
    expect(parseViewComment(doc, "v_pulse_membership_state")).toBeNull();
    expect(parseViewComment(doc, "v_pulse_nope")).toBeNull();
    expect(parseViewComment(null, "v_pulse_nope")).toBeNull();
  });
});
```
- [ ] **Step 3: Run tests, expect failure** — `npx vitest run test/pulse-views.test.ts` → FAIL "Cannot find module '../src/lib/pulse-views.js'".

- [ ] **Step 4: Add `lisbonDateString` to `src/lib/tz.ts`**

```ts
/** "YYYY-MM-DD" of `d` as a calendar day in Europe/Lisbon — the shape every
 * date column in the v_pulse_* views comes back in, so the two compare as
 * plain strings. */
export function lisbonDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Lisbon",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
```

- [ ] **Step 5: Write `src/lib/pulse-views.ts`**

```ts
/**
 * The bot's ONLY door into studio numbers: the curated v_pulse_* views in
 * the studio Supabase project (spec: docs/plans/2026-09-21-pulse-views-spec.md).
 * Raw kenko_* reads are being retired one view at a time; the ones still
 * allowed are listed in src/lib/kenko-allowlist.json and each maps to an
 * open pulse_cases row Mafalda is closing with a view.
 *
 * Two rules from the spec that every reader here follows:
 * - "Today" is the DATA date, never the calendar: data-as-of =
 *   max(cycle_starts_at) <= today over v_pulse_membership_state. A renewal
 *   after the last Kenko import is not a churn (Tatyana Khvesko, case #6).
 * - member_id = md5(lower(contact_email)) — no trim — is the join key
 *   every view exposes instead of the email itself.
 *
 * Every date column comes back as "YYYY-MM-DD"; compare as strings.
 */

import { createHash } from "node:crypto";

import { log } from "./log.js";
import { fetchAllPages, studioSupabase } from "./studio-supabase.js";

export const PULSE_VIEW = {
  membershipState: "v_pulse_membership_state",
  pauseHistory: "v_pulse_pause_history",
  introPurchase: "v_pulse_intro_purchase",
  introConversion: "v_pulse_intro_conversion",
  classpackState: "v_pulse_classpack_state",
  introHolderState: "v_pulse_intro_holder_state",
  knownCases: "v_pulse_known_cases",
} as const;

export type PulseViewName = (typeof PULSE_VIEW)[keyof typeof PULSE_VIEW];

export function memberIdFromEmail(email: string): string {
  return createHash("md5").update(email.toLowerCase()).digest("hex");
}

export interface MembershipStateRow {
  member_id: string;
  tier: string | null;
  plan: string | null;
  status: string | null;
  started: string | null;
  cycle_starts_at: string | null;
  cycle_expires_at: string | null;
  cycle_billing_ends_at: string | null;
  is_paying_cycle: boolean;
  is_paused: boolean;
  is_unpaid: boolean;
  churned_on: string | null;
  owes_dues: boolean;
}

export interface PauseHistoryRow {
  member_id: string;
  contact_name: string | null;
  contact_email: string | null;
  membership_name: string | null;
  cycle_start: string;
  cycle_end: string;
  membership_status: string | null;
  is_current: boolean;
  pause_days_est: number | null;
}

export interface IntroPurchaseRow {
  sale_id: number;
  email: string;
  member_id: string;
  item_name: string;
  pack: string;
  intro_purchase: string;
  kenko_start: string | null;
  intro_end: string;
  intro_end_source: "kenko" | "modeled";
  is_open_day: boolean;
  is_valentine: boolean;
  is_for_members: boolean;
}

export interface IntroConversionRow {
  member_id: string;
  intro_date: string;
  intro_end: string;
  pack: string;
  converted: boolean;
  converted_pack: boolean;
  pack_type: string | null;
  tier: string | null;
  days_to_convert: number | null;
}

export interface PackWindowRow {
  member_id: string;
  started: string | null;
  expires: string | null;
  has_credits?: boolean;
}

/** Latest cycle start on or before `today` ("YYYY-MM-DD"): the day the data
 * is good through. Null only on an empty view. */
export function computeDataAsOf(
  rows: Array<Pick<MembershipStateRow, "cycle_starts_at">>,
  today: string,
): string | null {
  let max: string | null = null;
  for (const r of rows) {
    const d = r.cycle_starts_at;
    if (!d || d > today) continue;
    if (!max || d > max) max = d;
  }
  return max;
}

export interface ActiveMember {
  memberId: string;
  tier: string; // "4x" | "8x" | "12x" | "Unlimited"
  plan: string; // "Premium" | "Essentials"
  membershipName: string; // "4x Monthly | Premium" — the label existing Notion rows carry
  memberSince: string; // start of the unbroken run of paying cycles ending in the live one
}

const CYCLE_GAP_TOLERANCE_DAYS = 3;

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}

/**
 * Start of the unbroken chain of PAYING cycles that ends in `current`:
 * walk back while the previous paying cycle ends within
 * CYCLE_GAP_TOLERANCE_DAYS of the next one's start. A win-back on the
 * same plan restarts here, where the view's `started` (first start ever
 * for that plan) would not — churn signals must not evaluate months from
 * the gap as "member but never came".
 */
export function continuousSince(cycles: MembershipStateRow[], current: MembershipStateRow): string {
  const paying = cycles
    .filter((c) => c.is_paying_cycle && c.cycle_starts_at)
    .sort((a, b) => (a.cycle_starts_at! < b.cycle_starts_at! ? -1 : 1));
  let since = current.cycle_starts_at!;
  for (let i = paying.length - 1; i >= 0; i--) {
    const prev = paying[i];
    if (prev.cycle_starts_at! >= since) continue;
    const prevEnd = prev.cycle_expires_at ?? prev.cycle_billing_ends_at;
    if (!prevEnd || daysBetween(prevEnd, since) > CYCLE_GAP_TOLERANCE_DAYS) break;
    since = prev.cycle_starts_at!;
  }
  return since;
}

/**
 * The spec's verification query, in code: paying cycles overlapping asOf,
 * one entry per member_id (the latest-starting live cycle wins when a plan
 * change overlaps). 75 on the 2026-09-18 snapshot.
 */
export function activeMembersAsOf(rows: MembershipStateRow[], asOf: string): Map<string, ActiveMember> {
  const byMember = new Map<string, MembershipStateRow[]>();
  for (const r of rows) {
    if (!r.cycle_starts_at) continue;
    const list = byMember.get(r.member_id) ?? [];
    list.push(r);
    byMember.set(r.member_id, list);
  }
  const out = new Map<string, ActiveMember>();
  for (const [memberId, cycles] of byMember) {
    const live = cycles
      .filter(
        (c) =>
          c.is_paying_cycle &&
          c.cycle_starts_at! <= asOf &&
          (c.cycle_expires_at === null || c.cycle_expires_at >= asOf),
      )
      .sort((a, b) => (a.cycle_starts_at! < b.cycle_starts_at! ? 1 : -1));
    const current = live[0];
    if (!current) continue;
    out.set(memberId, {
      memberId,
      tier: current.tier ?? "",
      plan: current.plan ?? "",
      membershipName: `${current.tier ?? "?"} Monthly | ${current.plan ?? "?"}`,
      memberSince: continuousSince(cycles, current),
    });
  }
  return out;
}

async function fetchView<T>(view: PulseViewName, select = "*"): Promise<T[]> {
  if (!studioSupabase) {
    log.warn("pulse_views.fetch_skipped", { view, reason: "studio_supabase_not_configured" });
    return [];
  }
  return fetchAllPages<T>((from, to) => studioSupabase!.from(view).select(select).range(from, to));
}

export const fetchMembershipState = () => fetchView<MembershipStateRow>(PULSE_VIEW.membershipState);
export const fetchPauseHistory = () => fetchView<PauseHistoryRow>(PULSE_VIEW.pauseHistory);
export const fetchIntroPurchases = () => fetchView<IntroPurchaseRow>(PULSE_VIEW.introPurchase);
export const fetchIntroConversion = () => fetchView<IntroConversionRow>(PULSE_VIEW.introConversion);
export const fetchClasspackState = () => fetchView<PackWindowRow>(PULSE_VIEW.classpackState);
export const fetchIntroHolderState = () => fetchView<PackWindowRow>(PULSE_VIEW.introHolderState);

// ---------------------------------------------------------------------------
// View COMMENTs, live. PostgREST publishes every COMMENT ON table/view as the
// `description` of that definition in its OpenAPI document at GET /rest/v1/.
// Supabase's gateway answers that endpoint only for the service_role key —
// which is what STUDIO_SUPABASE_KEY is (every kenko_* table is RLS
// service_role-only and the bot reads them). No studio-side object needed.
// ---------------------------------------------------------------------------

const OPENAPI_TTL_MS = 10 * 60_000;
let openapiCache: { at: number; doc: unknown } | null = null;

export function parseViewComment(openapi: unknown, view: string): string | null {
  const defs = (openapi as { definitions?: Record<string, { description?: unknown }> } | null)?.definitions;
  const d = defs?.[view]?.description;
  return typeof d === "string" && d.trim() ? d.trim() : null;
}

async function fetchOpenApi(): Promise<unknown | null> {
  const url = process.env.STUDIO_SUPABASE_URL;
  const key = process.env.STUDIO_SUPABASE_KEY;
  if (!url || !key) return null;
  if (openapiCache && Date.now() - openapiCache.at < OPENAPI_TTL_MS) return openapiCache.doc;
  const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
  });
  if (!res.ok) {
    log.warn("pulse_views.openapi_failed", { status: res.status });
    return null;
  }
  const doc: unknown = await res.json();
  openapiCache = { at: Date.now(), doc };
  return doc;
}

/** The view's COMMENT (pg_description), or null when the view has none /
 * the document can't be fetched. */
export async function getViewComment(view: string): Promise<string | null> {
  const doc = await fetchOpenApi();
  return doc ? parseViewComment(doc, view) : null;
}
```

- [ ] **Step 6: Run tests** — `npx vitest run test/pulse-views.test.ts` → all PASS (75 / Esen out / Andreia in are the spec's own checks). `npm run typecheck` clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pulse-views.ts src/lib/tz.ts test/pulse-views.test.ts test/fixtures/v_pulse_membership_state.2026-09-18.json
git commit -m "feat(pulse): add v_pulse view reader anchored to the data-as-of date"
```

---

### Task 2: `pulse-cases.ts` + `/flag` + `/casos`

**Files:**
- Create: `src/lib/pulse-cases.ts`
- Create: `src/lib/pulse-source.ts` (last-named-view memory; used by `/flag` now and "porquê?" in Task 3)
- Create: `src/bot/pulse.ts`
- Modify: `src/bot/index.ts` (register commands, after `bot.command("influencers", …)` at ~line 204)
- Modify: `src/bot/commands.ts` `handleHelp` text if it lists commands (check `src/prompts/` or the help string; add `/flag` and `/casos`)
- Create: `test/pulse-cases.test.ts`, `test/pulse-source.test.ts`

**Interfaces (produced):**
```ts
// pulse-cases.ts
export interface PulseCaseInput { raisedBy: string; source: "telegram" | "session"; subject: string; observed: string; expected: string; viewName?: string | null; evidence?: string | null }
export async function insertPulseCase(input: PulseCaseInput): Promise<number>
export interface KnownCase { id: number; status: string; raised_on: string; raised_by: string; source: string; view_name: string | null; subject: string; observed: string; expected: string; rule: string | null }
export async function listOpenCases(): Promise<KnownCase[]>
export function formatCasosList(rows: KnownCase[]): string
// pulse-source.ts
export function formatSourceLine(views: string[], asOf?: string | null): string   // "Fonte: a, b · dados até dd/mm/aaaa"
export function extractViewsFromText(text: string | undefined | null): string[]
export function rememberSource(chatId: number, views: string[]): void
export function lastSource(chatId: number): string[]
export function isWhyQuestion(text: string): boolean
// bot/pulse.ts
export async function handleFlag(ctx: Context): Promise<void>
export async function handleCasos(ctx: Context): Promise<void>
```

- [ ] **Step 1: Failing tests**

`test/pulse-source.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { extractViewsFromText, formatSourceLine, isWhyQuestion, lastSource, rememberSource } from "../src/lib/pulse-source.js";

describe("formatSourceLine", () => {
  it("names the views on one line", () => {
    expect(formatSourceLine(["v_pulse_membership_state", "v_pulse_pause_history"])).toBe("Fonte: v_pulse_membership_state, v_pulse_pause_history");
  });
  it("adds the data-as-of date when given", () => {
    expect(formatSourceLine(["v_pulse_membership_state"], "2026-09-18")).toBe("Fonte: v_pulse_membership_state · dados até 18/09/2026");
  });
});

describe("extractViewsFromText", () => {
  it("reads the views back out of a bot message", () => {
    expect(extractViewsFromText("3 clientes em risco\n\nFonte: v_pulse_membership_state, v_pulse_pause_history · dados até 18/09/2026")).toEqual(["v_pulse_membership_state", "v_pulse_pause_history"]);
  });
  it("is empty for a message with no Fonte line, or no text", () => {
    expect(extractViewsFromText("olá")).toEqual([]);
    expect(extractViewsFromText(undefined)).toEqual([]);
  });
});

describe("rememberSource / lastSource", () => {
  it("remembers per chat and ignores empty lists", () => {
    rememberSource(1, ["v_pulse_intro_purchase"]);
    rememberSource(1, []);
    expect(lastSource(1)).toEqual(["v_pulse_intro_purchase"]);
    expect(lastSource(2)).toEqual([]);
  });
});

describe("isWhyQuestion", () => {
  it.each(["porquê?", "Porquê", "porque?", "e porquê?", "why?", "Why", "por que?"])("matches %s", (t) => {
    expect(isWhyQuestion(t)).toBe(true);
  });
  it.each(["porque é que a Ana não aparece?", "why is this here", "ok"])("does not match %s", (t) => {
    expect(isWhyQuestion(t)).toBe(false);
  });
});
```

`test/pulse-cases.test.ts`:
```ts
import { describe, expect, it } from "vitest";

import { formatCasosList, type KnownCase } from "../src/lib/pulse-cases.js";

const row = (over: Partial<KnownCase>): KnownCase => ({
  id: 13, status: "open", raised_on: "2026-09-21", raised_by: "bot", source: "session", view_name: null,
  subject: "Identity view", observed: "o", expected: "e", rule: null, ...over,
});

describe("formatCasosList", () => {
  it("says so when nothing is open", () => {
    expect(formatCasosList([])).toBe("Sem casos abertos 🩵");
  });
  it("lists id, date, who, view and subject, one case per block", () => {
    const text = formatCasosList([row({}), row({ id: 18, raised_by: "madalena", view_name: "v_pulse_paused_detail", subject: "A Esen não está em pausa" })]);
    expect(text).toContain("Casos abertos (2)");
    expect(text).toContain("#13 · 21/09/2026 · bot\nIdentity view");
    expect(text).toContain("#18 · 21/09/2026 · madalena · v_pulse_paused_detail\nA Esen não está em pausa");
  });
});
```

- [ ] **Step 2: Run, expect failure** — `npx vitest run test/pulse-source.test.ts test/pulse-cases.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Write `src/lib/pulse-source.ts`**

```ts
/**
 * "Which view did that number come from?" — the memory behind two things
 * the spec asks for (docs/plans/2026-09-21-pulse-views-spec.md, steps 3-4):
 * every number the bot posts ends with a "Fonte: v_pulse_…" line, and
 * "porquê?" / "/flag" pick up the view named in the message being replied
 * to, else the last one named in that chat.
 */

const lastSourceByChat = new Map<number, string[]>();

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function formatSourceLine(views: string[], asOf?: string | null): string {
  const base = `Fonte: ${views.join(", ")}`;
  return asOf ? `${base} · dados até ${formatDatePt(asOf)}` : base;
}

export function extractViewsFromText(text: string | undefined | null): string[] {
  const m = text?.match(/^Fonte:\s*(.+)$/m);
  if (!m) return [];
  return m[1]
    .split("·")[0]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^v_pulse_[a-z_]+$/.test(s));
}

export function rememberSource(chatId: number, views: string[]): void {
  if (views.length > 0) lastSourceByChat.set(chatId, views);
}

export function lastSource(chatId: number): string[] {
  return lastSourceByChat.get(chatId) ?? [];
}

/** "porquê?", "porque?", "por que?", "e porquê?", "why?" — the bare
 * question only, so a real sentence still goes to the assistant. */
export function isWhyQuestion(text: string): boolean {
  return /^\s*(e\s+)?(porqu[eê]|por\s+que|why)\s*[?？!]*\s*$/i.test(text);
}
```

- [ ] **Step 4: Write `src/lib/pulse-cases.ts`**

```ts
/**
 * pulse_cases — the studio's ledger of "a number was wrong, here is what
 * Kenko showed, here is the rule". Open rows come from Madalena (/flag) or
 * from this bot (a question no view answers yet); Mafalda resolves them on
 * the studio side. Read through v_pulse_known_cases; write to the table.
 * Table is RLS service_role-only, which STUDIO_SUPABASE_KEY is.
 */

import { log } from "./log.js";
import { studioSupabase } from "./studio-supabase.js";

export interface PulseCaseInput {
  raisedBy: string;
  source: "telegram" | "session";
  subject: string;
  observed: string;
  expected: string;
  viewName?: string | null;
  evidence?: string | null;
}

export async function insertPulseCase(input: PulseCaseInput): Promise<number> {
  if (!studioSupabase) throw new Error("pulse_cases: studio supabase not configured");
  const { data, error } = await studioSupabase
    .from("pulse_cases")
    .insert({
      raised_by: input.raisedBy,
      source: input.source,
      subject: input.subject,
      observed: input.observed,
      expected: input.expected,
      view_name: input.viewName ?? null,
      evidence: input.evidence ?? null,
      status: "open",
    })
    .select("id")
    .single();
  if (error) throw new Error(`pulse_cases insert failed: ${error.message}`);
  const id = Number((data as { id: number | string }).id);
  log.info("pulse_cases.inserted", { id, raisedBy: input.raisedBy, source: input.source, viewName: input.viewName ?? null });
  return id;
}

export interface KnownCase {
  id: number;
  status: string;
  raised_on: string;
  raised_by: string;
  source: string;
  view_name: string | null;
  subject: string;
  observed: string;
  expected: string;
  rule: string | null;
}

export async function listOpenCases(): Promise<KnownCase[]> {
  if (!studioSupabase) throw new Error("pulse_cases: studio supabase not configured");
  const { data, error } = await studioSupabase
    .from("v_pulse_known_cases")
    .select("id, status, raised_on, raised_by, source, view_name, subject, observed, expected, rule")
    .eq("status", "open")
    .order("id", { ascending: true });
  if (error) throw new Error(`v_pulse_known_cases query failed: ${error.message}`);
  return (data ?? []) as KnownCase[];
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function formatCasosList(rows: KnownCase[]): string {
  if (rows.length === 0) return "Sem casos abertos 🩵";
  const blocks = rows.map((r) => {
    const head = [`#${r.id}`, formatDatePt(r.raised_on), r.raised_by, r.view_name].filter(Boolean).join(" · ");
    return `${head}\n${r.subject}`;
  });
  return `Casos abertos (${rows.length}):\n\n${blocks.join("\n\n")}`;
}
```

- [ ] **Step 5: Write `src/bot/pulse.ts`**

```ts
/**
 * Telegram surface for pulse_cases (spec step 3): /flag <texto> records
 * "this number is wrong" as an open case, /casos lists what's open, and
 * (Task 3) "porquê?" answers with the source view's COMMENT.
 */

import type { Context } from "grammy";

import { getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { formatCasosList, insertPulseCase, listOpenCases } from "../lib/pulse-cases.js";
import { extractViewsFromText, lastSource } from "../lib/pulse-source.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { lisbonDateString } from "../lib/tz.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function commandPayload(text: string | undefined, command: string): string {
  return (text ?? "").replace(new RegExp(`^/${command}(@\\w+)?\\s*`, "i"), "").trim();
}

export async function handleFlag(ctx: Context): Promise<void> {
  const founder = getFounderName(ctx.from?.id ?? 0);
  if (!founder || !ctx.chat) return;
  const text = commandPayload(ctx.message?.text, "flag");
  if (!text) {
    await ctx.reply("Uso: /flag <o que está errado> — ex.: /flag a Esen aparece como activa mas está em pausa");
    return;
  }
  if (!isStudioSupabaseAvailable()) {
    await ctx.reply("Supabase do estúdio não configurado — não consigo registar o caso.");
    return;
  }
  const replied = extractViewsFromText(ctx.message?.reply_to_message?.text);
  const views = replied.length > 0 ? replied : lastSource(ctx.chat.id);
  try {
    const id = await insertPulseCase({
      raisedBy: founder.toLowerCase(),
      source: "telegram",
      subject: text,
      observed: text,
      expected: "por confirmar no Kenko",
      viewName: views[0] ?? null,
      evidence: `Telegram /flag por ${founder}, ${lisbonDateString(new Date())}`,
    });
    await ctx.reply(`Registado como caso #${id}${views[0] ? ` (${views[0]})` : ""}. A Mafalda vê-o em v_pulse_known_cases.`);
  } catch (err) {
    log.error("pulse.flag_failed", { message: errMsg(err) });
    await ctx.reply("erro a registar o caso — tenta outra vez");
  }
}

export async function handleCasos(ctx: Context): Promise<void> {
  if (!getFounderName(ctx.from?.id ?? 0)) return;
  if (!isStudioSupabaseAvailable()) {
    await ctx.reply("Supabase do estúdio não configurado.");
    return;
  }
  try {
    await ctx.reply(formatCasosList(await listOpenCases()));
  } catch (err) {
    log.error("pulse.casos_failed", { message: errMsg(err) });
    await ctx.reply("erro a ler os casos — tenta outra vez");
  }
}
```

- [ ] **Step 6: Register in `src/bot/index.ts`** — after `bot.command("influencers", handleInfluencers);`:

```ts
  bot.command("flag", handleFlag);
  bot.command("casos", handleCasos);
```
with `import { handleCasos, handleFlag } from "./pulse.js";` next to the other bot imports. Add the two commands to the `/help` text (find it via `grep -n "influencers" src/bot/commands.ts src/prompts/*.md`) as:
```
/flag <texto> — marcar um número errado (vai para pulse_cases)
/casos — casos abertos
```

- [ ] **Step 7: Run** — `npx vitest run test/pulse-source.test.ts test/pulse-cases.test.ts` PASS; `npm run typecheck` clean; `npm run test` all green.

- [ ] **Step 8: Commit**

```bash
git add src/lib/pulse-cases.ts src/lib/pulse-source.ts src/bot/pulse.ts src/bot/index.ts src/bot/commands.ts test/pulse-cases.test.ts test/pulse-source.test.ts
git commit -m "feat(bot): add /flag and /casos backed by pulse_cases"
```
(add `src/prompts/*.md` to the `git add` if the help text lives there.)

---

### Task 3: "Fonte:" line on every posted number + "porquê?"

**Files:**
- Modify: `src/lib/pulse-source.ts` (add `sendGroupMessageWithSource`)
- Modify: `src/bot/pulse.ts` (add `handleWhy`)
- Modify: `src/bot/index.ts` (route "porquê?" in the group pipeline, **before** the `text.trim().length < 4` guard — "why" is 3 chars)
- Modify: `src/crons/churn-risk.ts`, `src/crons/leads-intro-pack.ts`, `src/crons/intro-pack-expiring.ts`, `src/crons/birthdays.ts` (use `sendGroupMessageWithSource`)
- Test: `test/pulse-source.test.ts` (extend)

**Interfaces (produced):**
```ts
export async function sendGroupMessageWithSource(text: string, views: string[], asOf?: string | null, pendingNote?: string): Promise<number>
export async function handleWhy(ctx: Context, repliedToText: string | undefined): Promise<boolean>  // true = handled
```

- [ ] **Step 1: Failing test** — append to `test/pulse-source.test.ts`:

```ts
import { vi } from "vitest";
const sendGroupMessage = vi.fn().mockResolvedValue(42);
vi.mock("../src/lib/telegram.js", () => ({ sendGroupMessage: (...a: unknown[]) => sendGroupMessage(...a) }));

describe("sendGroupMessageWithSource", () => {
  it("appends the Fonte line (and a pending note) and remembers the views for the group", async () => {
    process.env.TELEGRAM_GROUP_ID = "-100123";
    const { sendGroupMessageWithSource, lastSource } = await import("../src/lib/pulse-source.js");
    const id = await sendGroupMessageWithSource("3 em risco", ["v_pulse_membership_state"], "2026-09-18", "sinais ainda sem view (casos #16, #17, #19)");
    expect(id).toBe(42);
    expect(sendGroupMessage).toHaveBeenCalledWith(
      "3 em risco\n\nFonte: v_pulse_membership_state · dados até 18/09/2026\nsinais ainda sem view (casos #16, #17, #19)",
      undefined,
    );
    expect(lastSource(-100123)).toEqual(["v_pulse_membership_state"]);
  });
});
```
(Move the `vi.mock` to the top of the file — vitest hoists it, but keep it readable.)

- [ ] **Step 2: Run, expect failure** — `sendGroupMessageWithSource is not a function`.

- [ ] **Step 3: Implement** — in `src/lib/pulse-source.ts`:

```ts
import { sendGroupMessage } from "./telegram.js";

/** sendGroupMessage + the spec's "name the view it came from" line, and
 * remember it so "porquê?" / "/flag" in the group can find it. */
export async function sendGroupMessageWithSource(
  text: string,
  views: string[],
  asOf?: string | null,
  pendingNote?: string,
): Promise<number> {
  const tail = [formatSourceLine(views, asOf), pendingNote].filter(Boolean).join("\n");
  const id = await sendGroupMessage(`${text}\n\n${tail}`, undefined);
  const groupId = Number(process.env.TELEGRAM_GROUP_ID);
  if (groupId) rememberSource(groupId, views);
  return id;
}
```
Check `formatChurnDigest`/`formatLeadsDigest`/`formatExpiringIntroPacksDigest`/`formatBirthdayDigest` in `src/messages/*.ts` for a parse mode — if any passes `"HTML"`/`"MarkdownV2"` to `sendGroupMessage`, thread a `parseMode` argument through instead of `undefined` (the four crons above call `sendGroupMessage(message)` with no parse mode today, so `undefined` is right).

In `src/bot/pulse.ts`:
```ts
import { getViewComment } from "../lib/pulse-views.js";

/** "porquê?" → the COMMENT of the view named in the replied-to message,
 * else the last one named in this chat. Returns false when nothing was
 * named, so the assistant answers instead. */
export async function handleWhy(ctx: Context, repliedToText: string | undefined): Promise<boolean> {
  if (!ctx.chat) return false;
  const replied = extractViewsFromText(repliedToText);
  const views = replied.length > 0 ? replied : lastSource(ctx.chat.id);
  if (views.length === 0) return false;
  const parts: string[] = [];
  for (const view of views) {
    try {
      const comment = await getViewComment(view);
      parts.push(comment ? `${view}:\n${comment}` : `${view}: ainda sem descrição na base de dados.`);
    } catch (err) {
      log.warn("pulse.why_comment_failed", { view, message: errMsg(err) });
      parts.push(`${view}: não consegui ler a descrição agora.`);
    }
  }
  await ctx.reply(parts.join("\n\n"));
  return true;
}
```

In `src/bot/index.ts`, in the group pipeline right after `pushRecent(chatId, senderName, text);` and **before** `if (text.trim().length < 4) return;`:
```ts
    if (isWhyQuestion(text) && (await handleWhy(ctx, repliedToText))) return;
```
with imports `isWhyQuestion` from `../lib/pulse-source.js` and `handleWhy` from `./pulse.js`.

Crons — replace `sendGroupMessage(message)` with:
- `churn-risk.ts`: `sendGroupMessageWithSource(message, [PULSE_VIEW.membershipState, PULSE_VIEW.pauseHistory], asOf, "Sinais ainda lidos das tabelas Kenko até haver view (casos #16, #17, #19).")` — `asOf` comes from `fetchChurnFlags` after Task 5; until then pass `null`. Keep the import of `sendGroupMessage` only if still used elsewhere in the file.
- `leads-intro-pack.ts`: `sendGroupMessageWithSource(message, [PULSE_VIEW.introPurchase, PULSE_VIEW.introConversion])`
- `intro-pack-expiring.ts`: `sendGroupMessageWithSource(message, [PULSE_VIEW.introPurchase], null, "Nº de aulas ainda lido de kenko_bookings até haver view (caso #16).")` — write the note without the literal `kenko_bookings` if the guard (Task 8) is stricter than `"kenko_x"` string literals; the guard only matches exact-literal table names, so `"… lido de kenko_bookings …"` inside a longer string is fine.
- `birthdays.ts`: `sendGroupMessageWithSource(message, [PULSE_VIEW.membershipState, PULSE_VIEW.classpackState, PULSE_VIEW.introHolderState])`
Import `PULSE_VIEW` from `../lib/pulse-views.js` in each.

- [ ] **Step 4: Run** — `npm run test` green, `npm run typecheck` clean. Update the mocks in `test/churn-risk.test.ts`, `test/intro-pack-expiring.test.ts`, `test/birthdays.test.ts` if they mock `../src/lib/telegram.js` and assert on `sendGroupMessage` — the crons now go through `sendGroupMessageWithSource`, so either mock `../src/lib/pulse-source.js` or assert on the wrapped call (`expect(sendGroupMessage).toHaveBeenCalledWith(expect.stringContaining("Fonte: v_pulse_"), undefined)`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pulse-source.ts src/bot/pulse.ts src/bot/index.ts src/crons/churn-risk.ts src/crons/leads-intro-pack.ts src/crons/intro-pack-expiring.ts src/crons/birthdays.ts test/pulse-source.test.ts test/churn-risk.test.ts test/intro-pack-expiring.test.ts test/birthdays.test.ts
git commit -m "feat(bot): name the source view on every number and answer porquê? with its comment"
```

---

### Task 4: churn roster + pause windows from views (inventory rows 1, 2; closes cases #11, #12)

**Files:**
- Modify: `src/lib/churn-signals.ts` (`fetchChurnFlags` L312-425, `dedupeLatestPerEmail`, `computeChurnFlags` pause filter, delete `isExcludedEmail` + `STAFF_TEST_*` + `PAUSE_STRETCH_THRESHOLD_DAYS`)
- Modify: `src/crons/churn-risk.ts` (pass `asOf` to the Fonte line; docstring)
- Modify: `src/lib/intro-pack-conversion.ts` (drop the `isExcludedEmail` import — fully rewritten in Task 5, but the import must go now for typecheck)
- Modify: `test/churn-signals.test.ts` (delete `isExcludedEmail` block; replace "does not treat a normal ~30-day cycle as a pause" and "excludes staff/test accounts" tests)
- Modify: `test/churn-risk.test.ts` if it stubs `fetchChurnFlags` (add `asOf` to the stub's return)

**Interfaces:**
- Consumes: `fetchMembershipState`, `fetchPauseHistory`, `computeDataAsOf`, `activeMembersAsOf`, `memberIdFromEmail`, `lisbonDateString`.
- Produces: `fetchChurnFlags(now?: Date): Promise<{ flags: ChurnFlag[]; activeEmails: Set<string>; asOf: string | null }>` — new `asOf` field.

- [ ] **Step 1: Failing tests** — in `test/churn-signals.test.ts`:
  - delete the `describe("isExcludedEmail")` block and the `isExcludedEmail` import;
  - replace `it("does not treat a normal ~30-day cycle as a pause", …)` with:
```ts
  it("honours every pause window it is given — the view decides what a pause is, not this code", () => {
    // A 30-day window that overlaps the evaluated month must exclude that
    // month from signal 3 (pre-2026-09-21 this code ignored windows <= 45 d).
    const now = new Date("2026-09-16T08:00:00Z");
    const sub = subscriber("a@x.com", "2026-01-01");
    const paused = [{ email: "a@x.com", start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-08-31T00:00:00Z") }];
    const flags = computeChurnFlags([sub], recentBookingOnly(now), [], paused, now);
    expect(flags.find((f) => f.email === "a@x.com")?.signals.some((s) => s.type === "Baixa utilização")).toBeFalsy();
  });
```
  (reuse the file's existing helpers for a subscriber + a recent booking; if named differently, adapt — the assertion is what matters: a ≤45-day window still excludes its month.)
  - replace `it("excludes staff/test accounts even if they'd otherwise be flagged", …)` with:
```ts
  it("has no staff list of its own — a thehavenpilates.pt subscriber passed in is evaluated like anyone else (views already exclude staff)", () => {
    const now = new Date("2026-09-16T08:00:00Z");
    const flags = computeChurnFlags([subscriber("x@thehavenpilates.pt", "2026-01-01")], [], [], [], now);
    expect(flags.some((f) => f.email === "x@thehavenpilates.pt")).toBe(true);
  });
```

- [ ] **Step 2: Run, expect failure** — the pause test fails (window filtered out), the staff test fails (excluded).

- [ ] **Step 3: Implement in `src/lib/churn-signals.ts`**
  - Delete `STAFF_TEST_EXACT_EMAILS`, `STAFF_TEST_EMAIL_PATTERNS`, `isExcludedEmail`, `PAUSE_STRETCH_THRESHOLD_DAYS`, and in `computeChurnFlags` the line `if ((c.end.getTime() - c.start.getTime()) / 86_400_000 <= PAUSE_STRETCH_THRESHOLD_DAYS) continue;`. Update the `PausedCycleWindow` doc comment: "A billing cycle v_pulse_pause_history says was stretched by a pause (status Paused, or pause_days_est >= 7). Any calendar month signal 3 evaluates that overlaps this window is excluded."
  - In `dedupeLatestPerEmail` drop `|| isExcludedEmail(email)`.
  - Replace the body of `fetchChurnFlags` from the `Promise.all` down to `const subscribers` with:
```ts
  const today = lisbonDateString(now);
  const fourMonthsAgoIso = new Date(now.getTime() - 4 * 30 * 86_400_000).toISOString();
  const fortyFiveDaysAgoIso = new Date(now.getTime() - FAILED_PAYMENT_WINDOW_DAYS * 86_400_000).toISOString();

  const [stateRows, pauseRows, bookingRows, failedRows, customers] = await Promise.all([
    fetchMembershipState(),
    fetchPauseHistory(),
    // kenko-allowlist.json: signal 1 + signal 3 attendance — pulse_cases #16
    fetchAllPages<{ contact_email: string | null; booking_date: string | null; event_date: string | null; booking_status: string | null }>(
      (from, to) =>
        studioSupabase!
          .from("kenko_bookings")
          .select("contact_email, booking_date, event_date, booking_status")
          .gte("booking_date", fourMonthsAgoIso)
          .range(from, to),
    ),
    // kenko-allowlist.json: signal 2 — pulse_cases #17
    fetchAllPages<{ contact_email: string | null; payment_date: string | null }>((from, to) =>
      studioSupabase!
        .from("kenko_payments")
        .select("contact_email, payment_date")
        .eq("payment_status", "Failed")
        .gte("payment_date", fortyFiveDaysAgoIso)
        .range(from, to),
    ),
    // identity (name, email, phone) — pulse_cases #15; joined on member_id
    fetchAllCustomerNames(),
  ]);

  // "Today" is the data date, never the calendar (case #6, Tatyana Khvesko).
  const asOf = computeDataAsOf(stateRows, today);
  if (!asOf) {
    log.warn("churn_signals.no_data_as_of", { rows: stateRows.length });
    return { flags: [], activeEmails: new Set(), asOf: null };
  }
  const active = activeMembersAsOf(stateRows, asOf);

  const customersByMemberId = new Map<string, CustomerNameRecord>();
  for (const c of customers) if (c.email) customersByMemberId.set(memberIdFromEmail(c.email), c);

  const subscribers: ActiveSubscriber[] = [];
  for (const m of active.values()) {
    const c = customersByMemberId.get(m.memberId);
    if (!c?.email) {
      log.warn("churn_signals.member_without_identity", { memberId: m.memberId });
      continue;
    }
    subscribers.push({
      email: c.email.toLowerCase(),
      name: c.name,
      membershipName: m.membershipName,
      subscriptionStartsAt: new Date(`${m.memberSince}T00:00:00Z`),
    });
  }
```
  then keep the existing `bookings` / `failedPayments` mappings, replace the `pausedCycles` mapping with:
```ts
  const pausedCycles: PausedCycleWindow[] = pauseRows
    .filter((r) => r.contact_email && r.cycle_start && r.cycle_end)
    .map((r) => ({ email: r.contact_email!.toLowerCase(), start: new Date(`${r.cycle_start}T00:00:00Z`), end: new Date(`${r.cycle_end}T00:00:00Z`) }));
```
  and compute with the data date, not the clock: `const asOfDate = new Date(\`${asOf}T23:59:59Z\`); const flags = computeChurnFlags(subscribers, bookings, failedPayments, pausedCycles, asOfDate);`. Phones: `flag.telefone = customersByMemberId.get(memberIdFromEmail(flag.email))?.phone ?? null;` (drop the second `fetchAllCustomerNames()` call). Return `{ flags, activeEmails, asOf }`.
  Imports: `import { activeMembersAsOf, computeDataAsOf, fetchMembershipState, fetchPauseHistory, memberIdFromEmail } from "./pulse-views.js";`, `import { lisbonDateString } from "./tz.js";`, `type CustomerNameRecord` from `./leads.js`; drop `findPhoneByEmail`.
  - Rewrite the file's header comment: roster = `v_pulse_membership_state` as of the data date; pauses = `v_pulse_pause_history`; the two raw reads left and their case numbers; no staff list here.
  - `src/crons/churn-risk.ts`: destructure `asOf` from `fetchChurnFlags()` and pass it to `sendGroupMessageWithSource`. In the docstring, replace "subscription no longer Active" wording with "no longer a paying cycle in v_pulse_membership_state".
  - `src/lib/intro-pack-conversion.ts`: remove `import { isExcludedEmail } from "./churn-signals.js";` and the two `isExcludedEmail(...)` calls (their filtering is now the views' job; the file is rewritten in Task 5).

- [ ] **Step 4: Run** — `npm run test` green (fix `test/churn-risk.test.ts` stub to return `asOf: "2026-09-18"`), `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/churn-signals.ts src/crons/churn-risk.ts src/lib/intro-pack-conversion.ts test/churn-signals.test.ts test/churn-risk.test.ts
git commit -m "refactor(churn-signals): read the roster and pauses from v_pulse views"
```

- [ ] **Step 6: Close cases #11 and #12** (sha of the commit just made):

```sql
update pulse_cases set status='resolved', resolved_at=now(), resolved_in='<sha>' where id in (11, 12);
```

---

### Task 5: intro packs + conversion from views (inventory rows 5, 6, 7, 9)

**Files:**
- Modify: `src/lib/intro-pack-conversion.ts` (rewrite everything except `describePostExpiryVisit`, `fetchVisitHistory`, the interfaces `UnconvertedIntroPack` / `ExpiringIntroPackToWatch`)
- Modify: `src/crons/leads-reconcile.ts` (L35, L87-101 — `convertedMemberIds.has(pack.memberId)`)
- Modify: `test/intro-pack-conversion.test.ts` (replace `hasConvertedAfter` tests), `test/leads-reconcile.test.ts` (mock shape), `test/intro-pack-expiring.test.ts` if it builds `ExpiringIntroPackToWatch` rows (shape unchanged — check)
- Scripts under `scripts/*.mjs` import from `dist/` and keep working: `findUnconvertedIntroPacksInRange` keeps its signature.

**Interfaces (produced):**
```ts
export const TRACKED_PACKS: readonly ["2-Class", "10-Day"]
export interface IntroPackRow { memberId: string; email: string; name: string; packName: string; startsAt: Date; expiresAt: Date }
export function selectFirstTrackedPacks(rows: IntroPurchaseRow[], customers: CustomerNameRecord[]): Map<string, IntroPackRow>   // key = email
export interface ConversionCheckData { firstPackByEmail: Map<string, IntroPackRow>; convertedMemberIds: Set<string>; visitsByEmail: Map<string, VisitStats>; customers: CustomerNameRecord[] }
export async function loadConversionCheckData(): Promise<ConversionCheckData>
export async function findUnconvertedIntroPacks(cutoffDays?: number, now?: Date): Promise<UnconvertedIntroPack[]>          // unchanged signature
export async function findUnconvertedIntroPacksInRange(fromISO: string, toISO: string, now?: Date): Promise<UnconvertedIntroPack[]>  // unchanged
export async function findExpiringIntroPacksToWatch(daysAhead?: number, now?: Date): Promise<ExpiringIntroPackToWatch[]>   // unchanged
export function describePostExpiryVisit(c): string | null   // unchanged
```
`hasConvertedAfter`, `INTRO_PACK_NAMES`, `fetchAllSubscriptionStarts`, `fetchAllNonIntroMembershipStarts`, `fetchIntroPackFinishers` are deleted.

- [ ] **Step 1: Failing tests** — in `test/intro-pack-conversion.test.ts` replace the `hasConvertedAfter` block with:

```ts
import { selectFirstTrackedPacks } from "../src/lib/intro-pack-conversion.js";
import type { IntroPurchaseRow } from "../src/lib/pulse-views.js";
import { memberIdFromEmail } from "../src/lib/pulse-views.js";

function purchase(email: string, pack: string, intro_purchase: string, intro_end: string, over: Partial<IntroPurchaseRow> = {}): IntroPurchaseRow {
  return {
    sale_id: 1, email, member_id: memberIdFromEmail(email), item_name: `${pack} item`, pack, intro_purchase,
    kenko_start: intro_purchase, intro_end, intro_end_source: "kenko", is_open_day: false, is_valentine: false, is_for_members: false, ...over,
  };
}

describe("selectFirstTrackedPacks", () => {
  const customers = [{ name: "Sofia Orellana", email: "s@x.com", phone: "+351" }];

  it("keeps only 2-Class and 10-Day packs, first purchase per person, with the view's real expiry", () => {
    const out = selectFirstTrackedPacks(
      [purchase("s@x.com", "2-Class", "2026-08-27", "2026-09-14"), purchase("s@x.com", "10-Day", "2026-09-20", "2026-09-30"), purchase("o@x.com", "5-Class", "2026-08-01", "2026-08-22")],
      customers,
    );
    expect([...out.keys()]).toEqual(["s@x.com"]);
    expect(out.get("s@x.com")).toMatchObject({ name: "Sofia Orellana", packName: "2-Class item" });
    expect(out.get("s@x.com")!.expiresAt.toISOString().slice(0, 10)).toBe("2026-09-14");
  });

  it("skips Open Day / Valentine / for-members sales", () => {
    const out = selectFirstTrackedPacks([purchase("a@x.com", "2-Class", "2026-08-01", "2026-08-22", { is_for_members: true })], customers);
    expect(out.size).toBe(0);
  });

  it("falls back to the email as the name when no customer row matches", () => {
    const out = selectFirstTrackedPacks([purchase("nobody@x.com", "10-Day", "2026-08-01", "2026-08-11")], customers);
    expect(out.get("nobody@x.com")?.name).toBe("nobody@x.com");
  });
});
```

- [ ] **Step 2: Run, expect failure** — `selectFirstTrackedPacks` not exported.

- [ ] **Step 3: Rewrite `src/lib/intro-pack-conversion.ts`** (keep `describePostExpiryVisit`, `VisitStats`, `fetchVisitHistory` verbatim; `fetchVisitHistory` is the allowlisted `kenko_bookings` read — annotate it `// kenko-allowlist.json: pulse_cases #16`):

```ts
/**
 * Intro packs, from the studio's views (spec docs/plans/2026-09-21-pulse-views-spec.md):
 * - v_pulse_intro_purchase: one row per pack sold, intro_end = Kenko's own
 *   expiry from the ledger when the sale matched a pack (a hand-edited date
 *   shows up here: Carla Costa, 10-Day valid to 8 Sep not 1 Sep, case #7),
 *   else modeled — never compute purchase + 10/21 here.
 * - v_pulse_intro_conversion: converted (a 4x/8x/12x/Unlimited subscription
 *   on or after the purchase — mid-pack counts, Sofia Orellana, case #8) or
 *   converted_pack (a real 5x/10x pack; a drop-in is not a conversion, case
 *   #9). Either one means "never chase as a lead".
 * Only 2-Class and 10-Day packs are tracked here (the ones with volume —
 * founder's scope); the view also labels 5-Class / Open Day / Intro other.
 * Name + phone still come from the allowlisted kenko_customers read
 * (pulse_cases #15) joined on member_id; attendance from kenko_bookings
 * (pulse_cases #16).
 *
 * Day-21 threshold: empirically validated in session (see git history of
 * this file) — nobody in the 10-Day cohort converts between days 17-21, so
 * waiting costs it nothing and cuts false outreach for the 2-Class cohort.
 */

import { fetchAllCustomerNames, findPhoneByEmail, type CustomerNameRecord } from "./leads.js";
import { log } from "./log.js";
import { lisbonNaiveToUtcIso, lisbonDateString } from "./tz.js";
import {
  fetchIntroConversion,
  fetchIntroPurchases,
  memberIdFromEmail,
  type IntroPurchaseRow,
} from "./pulse-views.js";
import { fetchAllPages, studioSupabase } from "./studio-supabase.js";

export const TRACKED_PACKS = ["2-Class", "10-Day"] as const;
export const DEFAULT_CUTOFF_DAYS = 21;

export interface UnconvertedIntroPack { /* unchanged */ }
export interface IntroPackRow {
  memberId: string;
  email: string;
  name: string;
  packName: string; // the item as sold, e.g. "2 Classes | Premium"
  startsAt: Date;
  expiresAt: Date; // end of intro_end (Lisbon day), so a visit on that day is still "during"
}

function lisbonEndOfDay(dateStr: string): Date {
  return new Date(lisbonNaiveToUtcIso(`${dateStr}T23:59:59`));
}
function lisbonStartOfDay(dateStr: string): Date {
  return new Date(lisbonNaiveToUtcIso(`${dateStr}T00:00:00`));
}

/** Pure — no I/O. First tracked pack per person, keyed by email. */
export function selectFirstTrackedPacks(
  rows: IntroPurchaseRow[],
  customers: CustomerNameRecord[],
): Map<string, IntroPackRow> {
  const tracked = new Set<string>(TRACKED_PACKS);
  const nameByMemberId = new Map<string, string>();
  for (const c of customers) if (c.email && c.name) nameByMemberId.set(memberIdFromEmail(c.email), c.name);
  const out = new Map<string, IntroPackRow>();
  for (const r of rows) {
    if (!tracked.has(r.pack) || r.is_open_day || r.is_valentine || r.is_for_members) continue;
    const email = r.email.toLowerCase();
    const existing = out.get(email);
    if (existing && existing.startsAt <= lisbonStartOfDay(r.intro_purchase)) continue;
    out.set(email, {
      memberId: r.member_id,
      email,
      name: nameByMemberId.get(r.member_id) ?? email,
      packName: r.item_name,
      startsAt: lisbonStartOfDay(r.kenko_start ?? r.intro_purchase),
      expiresAt: lisbonEndOfDay(r.intro_end),
    });
  }
  return out;
}
```
  (Careful: the "first pack" comparison must use `intro_purchase`, not `kenko_start` — store `purchasedAt` alongside if needed; simplest is to sort `rows` by `intro_purchase` ascending first and keep the first seen per email.)

```ts
interface VisitStats { lastVisit: Date | null; count: number }
async function fetchVisitHistory(): Promise<Map<string, VisitStats>> { /* unchanged, kenko-allowlist.json: pulse_cases #16 */ }

export interface ConversionCheckData {
  firstPackByEmail: Map<string, IntroPackRow>;
  convertedMemberIds: Set<string>;
  visitsByEmail: Map<string, VisitStats>;
  customers: CustomerNameRecord[];
}

export async function loadConversionCheckData(): Promise<ConversionCheckData> {
  const [purchases, conversions, visitsByEmail, customers] = await Promise.all([
    fetchIntroPurchases(),
    fetchIntroConversion(),
    fetchVisitHistory(),
    fetchAllCustomerNames(),
  ]);
  const sorted = [...purchases].sort((a, b) => (a.intro_purchase < b.intro_purchase ? -1 : 1));
  const firstPackByEmail = selectFirstTrackedPacks(sorted, customers);
  const convertedMemberIds = new Set(conversions.filter((c) => c.converted || c.converted_pack).map((c) => c.member_id));
  return { firstPackByEmail, convertedMemberIds, visitsByEmail, customers };
}

function toUnconverted(row: IntroPackRow, now: Date, visitsByEmail: Map<string, VisitStats>, customers: CustomerNameRecord[]): UnconvertedIntroPack { /* unchanged body */ }

export async function findUnconvertedIntroPacks(cutoffDays: number = DEFAULT_CUTOFF_DAYS, now: Date = new Date()): Promise<UnconvertedIntroPack[]> {
  if (!studioSupabase) { log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_supabase_not_configured" }); return []; }
  const { firstPackByEmail, convertedMemberIds, visitsByEmail, customers } = await loadConversionCheckData();
  const out: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (convertedMemberIds.has(row.memberId)) continue;
    const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
    if (daysSinceExpiry >= cutoffDays) out.push(toUnconverted(row, now, visitsByEmail, customers));
  }
  return out;
}

export async function findUnconvertedIntroPacksInRange(fromISO: string, toISO: string, now: Date = new Date()): Promise<UnconvertedIntroPack[]> {
  /* same as before, with `convertedMemberIds.has(row.memberId)` in place of hasConvertedAfter */
}

export interface ExpiringIntroPackToWatch { /* unchanged */ }
const TWO_CLASSES = "2-Class";
const TEN_DAY = "10-Day";

export async function findExpiringIntroPacksToWatch(daysAhead = 3, now: Date = new Date()): Promise<ExpiringIntroPackToWatch[]> {
  if (!studioSupabase) { log.warn("intro_pack_expiring.fetch_skipped", { reason: "studio_supabase_not_configured" }); return []; }
  const today = lisbonDateString(now);
  const until = lisbonDateString(new Date(now.getTime() + daysAhead * 86_400_000));
  const [purchases, visitsByEmail, customers] = await Promise.all([fetchIntroPurchases(), fetchVisitHistory(), fetchAllCustomerNames()]);
  const out: ExpiringIntroPackToWatch[] = [];
  for (const r of purchases) {
    if (r.is_open_day || r.is_valentine || r.is_for_members) continue;
    if (r.intro_end < today || r.intro_end > until) continue;
    const email = r.email.toLowerCase();
    const visitCount = visitsByEmail.get(email)?.count ?? 0;
    if (r.pack === TWO_CLASSES && visitCount !== 1) continue;
    if (r.pack === TEN_DAY && visitCount <= 5) continue;
    if (r.pack !== TWO_CLASSES && r.pack !== TEN_DAY) continue;
    out.push({ email, name: nameFor(email, r.member_id, customers), phone: findPhoneByEmail(email, customers), packName: r.item_name, expiresAt: lisbonEndOfDay(r.intro_end), visitCount });
  }
  out.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  return out;
}
```
  (`nameFor` = customers lookup by `memberIdFromEmail` with the email as fallback — write it once at module level and reuse in `selectFirstTrackedPacks`.)

  `src/crons/leads-reconcile.ts`: import only `loadConversionCheckData`; replace the destructure with `const { firstPackByEmail, convertedMemberIds } = await loadConversionCheckData();` and the check with `if (convertedMemberIds.has(pack.memberId)) {`. Update the docstring bullet about Intro Pack leads: "converted = v_pulse_intro_conversion converted OR converted_pack (a 5x/10x pack — never chase as a lead; a drop-in is not a conversion)".

  `test/leads-reconcile.test.ts`: the mock no longer needs `hasConvertedAfter`; return `{ firstPackByEmail, convertedMemberIds: new Set([...]) }` from `loadConversionCheckData` and give the fake pack rows a `memberId`.

- [ ] **Step 4: Run** — `npm run test` green, `npm run typecheck` clean, `npm run build` clean (scripts import from dist).

- [ ] **Step 5: Commit**

```bash
git add src/lib/intro-pack-conversion.ts src/crons/leads-reconcile.ts test/intro-pack-conversion.test.ts test/leads-reconcile.test.ts
git commit -m "refactor(intro-pack): read packs and conversion from v_pulse views"
```

---

### Task 6: birthday audience from views (inventory rows 13, 14)

**Files:**
- Modify: `src/lib/birthdays.ts` (`fetchActiveContactEmails` → `fetchActiveMemberIds`, docstring, keep the allowlisted `kenko_customers` DOB read annotated `// kenko-allowlist.json: pulse_cases #15`)
- Modify: `test/birthdays.test.ts` (check what it mocks; `filterUpcomingBirthdays` is pure and unchanged)

- [ ] **Step 1: Failing test** — add to `test/birthdays.test.ts`:

```ts
import { activeMemberIdsForBirthdays } from "../src/lib/birthdays.js";

describe("activeMemberIdsForBirthdays", () => {
  const asOf = "2026-09-18";
  it("unions paying members, live class packs with credits, and live intro holders", () => {
    const ids = activeMemberIdsForBirthdays(
      new Map([["m1", { memberId: "m1", tier: "4x", plan: "Premium", membershipName: "4x Monthly | Premium", memberSince: "2026-01-01" }]]),
      [{ member_id: "p1", started: "2026-09-01", expires: "2026-12-01", has_credits: true }, { member_id: "p2", started: "2026-09-01", expires: "2026-12-01", has_credits: false }, { member_id: "p3", started: "2026-01-01", expires: "2026-02-01", has_credits: true }],
      [{ member_id: "i1", started: "2026-09-10", expires: "2026-09-30" }, { member_id: "i2", started: "2026-08-01", expires: "2026-08-22" }],
      asOf,
    );
    expect([...ids].sort()).toEqual(["i1", "m1", "p1"]);
  });
});
```

- [ ] **Step 2: Run, expect failure.**

- [ ] **Step 3: Implement**

```ts
import { activeMembersAsOf, computeDataAsOf, fetchClasspackState, fetchIntroHolderState, fetchMembershipState, memberIdFromEmail, type ActiveMember, type PackWindowRow } from "./pulse-views.js";
import { lisbonDateString } from "./tz.js";

/** Pure — no I/O. Who gets a birthday message: a paying member, a class-pack
 * holder with credits left, or an intro-pack holder, all as of the data date. */
export function activeMemberIdsForBirthdays(
  members: Map<string, ActiveMember>,
  classpacks: PackWindowRow[],
  introHolders: PackWindowRow[],
  asOf: string,
): Set<string> {
  const live = (w: PackWindowRow) => !!w.started && w.started <= asOf && (!w.expires || w.expires >= asOf);
  const ids = new Set(members.keys());
  for (const w of classpacks) if (live(w) && w.has_credits) ids.add(w.member_id);
  for (const w of introHolders) if (live(w)) ids.add(w.member_id);
  return ids;
}

async function fetchActiveMemberIds(now: Date): Promise<Set<string>> {
  const [stateRows, classpacks, introHolders] = await Promise.all([fetchMembershipState(), fetchClasspackState(), fetchIntroHolderState()]);
  const asOf = computeDataAsOf(stateRows, lisbonDateString(now));
  if (!asOf) return new Set();
  return activeMemberIdsForBirthdays(activeMembersAsOf(stateRows, asOf), classpacks, introHolders, asOf);
}
```
  In `fetchUpcomingBirthdays`, replace the `activeEmails` set + filter with `const activeIds = await fetchActiveMemberIds(from);` and `.filter((r) => activeIds.has(memberIdFromEmail(r.contact_email)))`. Delete `ACTIVE_MEMBERSHIP_TYPES` and `fetchActiveContactEmails`. Rewrite the header comment: the "opaque member_id with no discoverable mapping" paragraph is wrong now — it is `md5(lower(email))`, and intro-pack holders are included.

- [ ] **Step 4: Run** — `npm run test` green, `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/birthdays.ts test/birthdays.test.ts
git commit -m "refactor(birthdays): read the active audience from v_pulse views"
```

---

### Task 7: the `kenko_` guard, the allowlist, CLAUDE.md, knowledge base

**Files:**
- Create: `src/lib/kenko-allowlist.json`
- Create: `test/kenko-guard.test.ts`
- Modify: `CLAUDE.md` (Architecture → new "Studio numbers" paragraph; cron table rows for churn-risk / leads-intro-pack / intro-pack-expiring / birthdays / leads-reconcile mention the views)
- Create: `docs/knowledge-base/pulse-views.md`; add a line to `docs/knowledge-base/README.md`

- [ ] **Step 1: Write the allowlist**

```json
{
  "_": "Raw kenko_* reads still allowed, each waiting on a view (pulse_cases id). Must be EMPTY once the views are live. test/kenko-guard.test.ts fails on any read not listed here and on any entry that no longer matches code.",
  "entries": [
    { "file": "src/lib/churn-signals.ts", "table": "kenko_bookings", "case": 16, "why": "signal 1 last booking + signal 3 attendance" },
    { "file": "src/lib/churn-signals.ts", "table": "kenko_payments", "case": 17, "why": "signal 2 failed payments" },
    { "file": "src/lib/intro-pack-conversion.ts", "table": "kenko_bookings", "case": 16, "why": "last visit + visit count" },
    { "file": "src/lib/leads.ts", "table": "kenko_customers", "case": 15, "why": "name, email, phone by member_id" },
    { "file": "src/lib/leads.ts", "table": "kenko_payments", "case": 18, "why": "hasRealPurchase" },
    { "file": "src/lib/leads.ts", "table": "kenko_sale_items", "case": 18, "why": "hasRealPurchase" },
    { "file": "src/lib/birthdays.ts", "table": "kenko_customers", "case": 15, "why": "date_of_birth" }
  ]
}
```
(Use the real ids from Task 0 Step 2.)

- [ ] **Step 2: Write the guard test**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Studio numbers come only from v_pulse_* views. A raw kenko_* read is
// allowed only while it is listed in src/lib/kenko-allowlist.json with the
// pulse_cases id of the view that will replace it — and that file must be
// empty when the views are live. Spec: docs/plans/2026-09-21-pulse-views-spec.md.

const ROOT = new URL("../", import.meta.url).pathname;
const SRC = join(ROOT, "src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function foundReads(): Set<string> {
  const out = new Set<string>();
  for (const file of tsFiles(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/["'`](kenko_[a-z_]+)["'`]/g)) {
      out.add(`${relative(ROOT, file)}:${m[1]}`);
    }
  }
  return out;
}

const allowlist = JSON.parse(readFileSync(join(SRC, "lib/kenko-allowlist.json"), "utf8")) as {
  entries: { file: string; table: string; case: number }[];
};
const allowed = new Set(allowlist.entries.map((e) => `${e.file}:${e.table}`));

describe("kenko_ guard", () => {
  it("every raw kenko_* read in src/ is in the allowlist (read a v_pulse_* view instead; no view? add a pulse_cases row)", () => {
    const offenders = [...foundReads()].filter((k) => !allowed.has(k)).sort();
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still matches a read (delete stale entries when a view lands)", () => {
    const found = foundReads();
    const stale = [...allowed].filter((k) => !found.has(k)).sort();
    expect(stale).toEqual([]);
  });

  it("every allowlist entry names the pulse_cases row it waits on", () => {
    for (const e of allowlist.entries) expect(e.case).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run** — `npx vitest run test/kenko-guard.test.ts`. Expect PASS with exactly the seven entries; if it lists an offender, that is a read Tasks 4-6 missed — fix the code, not the list. Sanity-check the guard actually bites: temporarily add `"kenko_leads"` as a string in any src file → the first test fails → revert.

- [ ] **Step 4: CLAUDE.md** — under "## Architecture" add, before "### Notion wrapper":

```markdown
### Studio numbers (`src/lib/pulse-views.ts`)

**Studio numbers come only from `v_pulse_*` views. A number that looks wrong becomes a `pulse_cases` row, never a local fix.** `src/lib/pulse-views.ts` is the only reader; "today" is the data-as-of date (`max(cycle_starts_at) <= today` over `v_pulse_membership_state`), never the calendar; `member_id = md5(lower(email))`. The seven raw `kenko_*` reads still allowed are listed in `src/lib/kenko-allowlist.json`, each against the open `pulse_cases` id of the view replacing it — `test/kenko-guard.test.ts` fails on anything else, and the list must be empty once those views ship. No staff list lives in the bot: the views exclude staff. Every number the bot posts ends with `Fonte: v_pulse_…`; "porquê?" in the group answers with that view's COMMENT (read live from PostgREST's OpenAPI root); `/flag <texto>` records a wrong number as an open case; `/casos` lists them. Spec and inventory: `docs/plans/2026-09-21-pulse-views-spec.md`; operating notes: `docs/knowledge-base/pulse-views.md`.
```
and in the cron table, prefix the churn-risk / leads-intro-pack / intro-pack-expiring / birthdays / leads-reconcile "What" cells with the view(s) they read (one clause each, e.g. "Roster from `v_pulse_membership_state` as of the data date, pauses from `v_pulse_pause_history`; …"). Also add `/flag`, `/casos` to the message-pipeline diagram line for slash commands.

- [ ] **Step 5: `docs/knowledge-base/pulse-views.md`** — sections: (1) why (the 2026-09-21 audit, link to spec); (2) the views the bot reads and for what; (3) data-as-of and member_id rules; (4) how "porquê?" gets comments (OpenAPI root, service_role only, 10-min cache; if it ever returns "ainda sem descrição", check `curl -H 'Accept: application/openapi+json' $STUDIO_SUPABASE_URL/rest/v1/` with the service key on the NAS); (5) pulse_cases workflow (`/flag` → open row → Mafalda resolves with rule + sha; bot-raised rows for missing views); (6) the allowlist and how to retire an entry (swap the read, delete the entry, the guard's second test forces it); (7) gotchas: matviews have no anon/authenticated grant, PostgREST paging still applies to views, `is_paying_cycle` already encodes Cancelation scheduled / NULL = pause scheduled, `converted_pack` = never chase. Add the file to `docs/knowledge-base/README.md`'s list.

- [ ] **Step 6: Run everything** — `npm run typecheck && npm run test && npm run build`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/kenko-allowlist.json test/kenko-guard.test.ts CLAUDE.md docs/knowledge-base/pulse-views.md docs/knowledge-base/README.md docs/plans/2026-09-21-pulse-views-spec.md docs/plans/2026-09-21-pulse-views.md
git commit -m "test(guard): fail on kenko_ reads outside the allowlist; document the pulse-views rule"
```

---

### Task 8: Verification against the spec (no code)

- [ ] `select id, status, resolved_in from v_pulse_known_cases where id in (11,12)` → both `resolved`, `resolved_in` = Task 4's sha.
- [ ] `test/pulse-views.test.ts` pins active = 75 on the 2026-09-18 snapshot, Esen out, Andreia in — same query as the spec, in code, on real rows.
- [ ] Sofia Orellana / Carla Costa — live: `select p.pack, p.intro_end, p.intro_end_source, c.converted from v_pulse_intro_purchase p join v_pulse_intro_conversion c using (member_id) where p.member_id in ('4b160c4b9d7fdd260b6370361d26d72e','26f6c8c2e3422bdf21e065a0607e3f6d')` → Sofia `converted=true` (the bot skips her: `convertedMemberIds.has`), Carla `intro_end=2026-09-08`.
- [ ] Guard green with the seven entries (empty-allowlist run happens when the views land — Mafalda's call, spec decisions).
- [ ] `/flag teste` — needs the deployed bot (Telegram + service key on the NAS): after `git pull && npm run build && sudo docker compose build --no-cache && sudo docker compose up -d`, type `/flag teste` in the group, then `select * from v_pulse_known_cases where subject='teste'` shows the row → `delete from pulse_cases where subject='teste' and source='telegram'`. Then "porquê?" as a reply to a cron digest → the view comment; if it says "ainda sem descrição", the OpenAPI root is not returning `definitions` for matviews — run the curl in `docs/knowledge-base/pulse-views.md` §4 on the NAS and report.
