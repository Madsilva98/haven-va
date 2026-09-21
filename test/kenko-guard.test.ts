import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Studio numbers come only from v_pulse_* views. A raw kenko_* read is
// allowed only while it is listed in src/lib/kenko-allowlist.json with the
// pulse_cases id of the view that will replace it — and that file is empty
// now that every view exists (spec: docs/plans/2026-09-21-pulse-views-spec.md).
// The bot's Postgres role could not read a kenko_* table anyway; this test
// keeps anyone from trying, or from smuggling a definition back in.

const ROOT = fileURLToPath(new URL("../", import.meta.url));
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

// Every string / template literal in the file, comments already stripped.
// A query is always a literal, so this is where a raw read would hide.
const LITERALS = /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

// What must never appear inside one: a kenko_* table name (anywhere in the
// literal, e.g. `select * from kenko_customers`), the public schema (the
// bot's role has nothing there), or the service_role key by name.
const FORBIDDEN: [RegExp, string][] = [
  [/\bkenko_\w+/g, "kenko table"],
  [/\bpublic\./g, "public. schema"],
  [/\bservice_role\b/g, "service_role"],
];

export function findForbidden(code: string): string[] {
  const out: string[] = [];
  for (const lit of stripComments(code).match(LITERALS) ?? []) {
    for (const [re, label] of FORBIDDEN) {
      for (const m of lit.match(re) ?? []) out.push(`${label}:${m}`);
    }
  }
  return out;
}

function foundReads(): Set<string> {
  const out = new Set<string>();
  for (const file of tsFiles(SRC)) {
    for (const hit of findForbidden(readFileSync(file, "utf8"))) {
      out.add(`${relative(ROOT, file)}:${hit}`);
    }
  }
  return out;
}

const allowlist = JSON.parse(readFileSync(join(SRC, "lib/kenko-allowlist.json"), "utf8")) as {
  entries: { file: string; table: string; case: number }[];
};
const allowed = new Set(allowlist.entries.map((e) => `${e.file}:kenko table:${e.table}`));

describe("kenko_ guard", () => {
  it("no kenko_* / public. / service_role string exists in src/ outside the allowlist (read a v_pulse_* view; no view? add a pulse_cases row)", () => {
    const offenders = [...foundReads()].filter((k) => !allowed.has(k)).sort();
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry still matches a read (delete stale entries when a view lands)", () => {
    const found = foundReads();
    const stale = [...allowed].filter((k) => !found.has(k)).sort();
    expect(stale).toEqual([]);
  });

  it("the allowlist is empty — every studio question has a view", () => {
    expect(allowlist.entries).toEqual([]);
  });

  it("the guard itself bites: a table name inside a query literal, public., service_role — and not in comments", () => {
    expect(findForbidden("query(`select * from kenko_customers where x = $1`)")).toEqual(["kenko table:kenko_customers"]);
    expect(findForbidden('const t = "kenko_leads";')).toEqual(["kenko table:kenko_leads"]);
    expect(findForbidden("currval('public.pulse_cases_id_seq')")).toEqual(["public. schema:public."]);
    expect(findForbidden('const k = "service_role";')).toEqual(["service_role:service_role"]);
    expect(findForbidden("// kenko_comment\n/* select * from public.kenko_x */\nconst ok = `select * from v_pulse_x`;")).toEqual([]);
    expect(findForbidden('const url = "https://x.y/kenko_path"; // \"kenko_z\"')).toEqual(["kenko table:kenko_path"]);
  });
});
