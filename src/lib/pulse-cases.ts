/**
 * pulse_cases — the studio's ledger of "a number was wrong, here is what
 * Kenko showed, here is the rule". Open rows come from Madalena (/flag) or
 * from this bot (a question no view answers yet); Mafalda resolves them on
 * the studio side with a rule and a commit. Read through v_pulse_known_cases
 * (open first); write through va.pulse_cases, an insert-only 7-column view
 * (status/id/resolved_* are defaults the bot cannot set).
 */

import { log } from "./log.js";
import { query, withTransaction } from "./studio-db.js";

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
  // insert + lastval() in one transaction: the id is not a column of the
  // insert-only view, and a transaction-mode pooler could split two plain
  // queries across backends (harmless in session mode, kept anyway).
  const id = await withTransaction(async (client) => {
    await client.query(
      `insert into pulse_cases (raised_by, source, view_name, subject, observed, expected, evidence)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.raisedBy,
        input.source,
        input.viewName ?? null,
        input.subject,
        input.observed,
        input.expected,
        input.evidence ?? null,
      ],
    );
    const res = await client.query<{ id: string | number }>("select lastval() as id");
    return Number(res.rows[0]?.id);
  });
  log.info("pulse_cases.inserted", {
    id,
    raisedBy: input.raisedBy,
    source: input.source,
    viewName: input.viewName ?? null,
  });
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
  return query<KnownCase>(
    `select id, status, raised_on, raised_by, source, view_name, subject, observed, expected, rule
       from v_pulse_known_cases where status = 'open' order by id`,
  );
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
