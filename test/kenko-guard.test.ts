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

// A kenko_* table name as a whole string literal: the shape of a table
// reference in a query. Prose that merely mentions a table inside a longer
// string is not a read.
const TABLE_LITERAL = /["'`](kenko_[a-z_]+)["'`]/g;

function foundReads(): Set<string> {
  const out = new Set<string>();
  for (const file of tsFiles(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(TABLE_LITERAL)) {
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
  it("no raw kenko_* read exists in src/ outside the allowlist (read a v_pulse_* view; no view? add a pulse_cases row)", () => {
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

  it("the guard itself bites: a table literal is detected", () => {
    const sample = stripComments('const t = "kenko_leads"; // kenko_comment\n/* "kenko_block" */');
    expect([...sample.matchAll(TABLE_LITERAL)].map((m) => m[1])).toEqual(["kenko_leads"]);
  });
});
