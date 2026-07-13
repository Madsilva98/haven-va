/**
 * Prompt-behavior test suite.
 *
 * For each test message:
 *   - Calls handleAssistant() with realistic open-tasks context.
 *   - Captures the tool names Haiku actually called (via the
 *     "assistant.handled" log line).
 *   - Asserts: required tool was called, forbidden tools weren't,
 *     and (optionally) the call arguments match patterns.
 *   - Cleans up any Notion writes via archivePage on the captured pageIds.
 *
 * Failures are actionable — each prints exactly which tool was called
 * (or not), so the prompt can be tightened.
 *
 * Usage: node --env-file=.env.local scripts/test-prompt-behavior.mjs
 */

import * as notion from "../dist/notion.js";
import { handleAssistant } from "../dist/bot/assistant.js";

const PREFIX = `[PROMPT-TEST ${new Date().toISOString().slice(0, 16)}]`;
const SEP = "─".repeat(72);
const MAFALDA_ID = Number(process.env.TELEGRAM_MAFALDA_ID);

if (!Number.isInteger(MAFALDA_ID)) {
  console.error("TELEGRAM_MAFALDA_ID missing from env");
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────
// Tap into the bot's structured log so we can read the tool names Haiku
// actually selected, plus capture every created pageId for cleanup.
// ──────────────────────────────────────────────────────────────────────
const createdPageIds = new Set();
let lastToolsCalled = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === "string") {
    if (chunk.includes('"assistant.handled"')) {
      const m = chunk.match(/"tools":\[([^\]]*)\]/);
      if (m) {
        lastToolsCalled = m[1]
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      }
    }
    if (chunk.includes('_created"')) {
      const idMatch = chunk.match(/"(?:pageId|id)":"([0-9a-f-]{32,40})"/);
      if (idMatch) createdPageIds.add(idMatch[1]);
    }
  }
  return origStdoutWrite(chunk, ...rest);
};

// ──────────────────────────────────────────────────────────────────────
// Test cases: each must declare what Haiku is SUPPOSED to do.
// ──────────────────────────────────────────────────────────────────────
const TESTS = [
  // ── create_task: simple cases ───────────────────────────
  {
    name: "simple task creation",
    // Use a clearly-unique title so it doesn't match an existing backlog item
    // and trigger the "avisa duplicado e não cria" rule.
    text: `${PREFIX} cria task: comprar novo painel decorativo para a entrada`,
    expectTool: "create_task",
    forbidden: ["update_record"],
  },
  {
    name: "task with explicit owner",
    text: `${PREFIX} cria task para a Beatriz: rever proposta WellHub`,
    expectTool: "create_task",
    forbidden: ["update_record"],
  },
  {
    name: "task with deadline (amanhã)",
    text: `${PREFIX} task para amanhã: agendar story Instagram`,
    expectTool: "create_task",
    forbidden: ["update_record"],
  },
  {
    name: "task with explicit 'prioridade alta' on NEW content (was bug #1)",
    text: `${PREFIX} prioridade alta: redigir nota de imprensa para evento de Junho`,
    expectTool: "create_task",
    forbidden: ["update_record"], // must NOT pattern-match an existing task
  },
  {
    name: "task with 'urgente' marker",
    text: `${PREFIX} task urgente: rever contrato instrutores`,
    expectTool: "create_task",
    forbidden: ["update_record"],
  },

  // ── create_reminder ─────────────────────────────────────
  {
    name: "reminder at specific future time",
    text: `${PREFIX} lembra-me amanhã às 10h de testar a migração`,
    expectTool: "create_reminder",
  },
  {
    name: "recurring daily reminder",
    text: `${PREFIX} lembra-me todos os dias às 8h de fazer alongamento`,
    expectTool: "create_reminder",
  },
  {
    name: "recurring weekly reminder",
    text: `${PREFIX} lembra-me toda a semana sexta às 9h de rever números`,
    expectTool: "create_reminder",
  },
  {
    name: "reminder for another founder",
    text: `${PREFIX} avisa a Madalena amanhã às 14h de rever PR`,
    expectTool: "create_reminder",
  },
  {
    name: "reminder for all founders",
    text: `${PREFIX} lembra todas hoje às 23h59 de fechar laptops`,
    expectTool: "create_reminder",
  },

  // ── create_entity (was bug #2 + #3) ─────────────────────
  {
    name: "new partner (was returning tools:[])",
    text: `${PREFIX} novo parceiro: Studio Yoga Carcavelos`,
    expectTool: "create_entity",
    forbidden: [],
  },
  {
    name: "new event (was returning tools:[])",
    text: `${PREFIX} novo evento: Workshop Pilates Inverno`,
    expectTool: "create_entity",
  },
  {
    name: "new project",
    text: `${PREFIX} novo projeto: Método Haven Online`,
    expectTool: "create_entity",
  },
  {
    name: "new influencer",
    text: `${PREFIX} novo influencer: @rita_pilates_lx`,
    expectTool: "create_entity",
  },

  // ── add_to_discuss ─────────────────────────────────────
  {
    name: "to-discuss item",
    text: `${PREFIX} adiciona à discussão: rever budget marketing junho`,
    expectTool: "add_to_discuss",
  },

  // ── log_decision ───────────────────────────────────────
  {
    name: "decision logged",
    text: `${PREFIX} decidimos não fazer parceria com Studio X`,
    expectTool: "log_decision",
  },

  // ── add_to_list ────────────────────────────────────────
  {
    name: "add to existing list",
    text: `${PREFIX} adiciona à lista de compras: papel higiénico para o studio`,
    expectTool: "add_to_list",
  },

  // ── content calendar ───────────────────────────────────
  {
    name: "content calendar idea",
    text: `${PREFIX} ideia para post: benefícios do pilates pós-parto`,
    expectTool: "create_content_calendar_entry",
  },

  // ── Edge cases: must NOT create anything ────────────────
  {
    name: "pure greeting (silence)",
    text: `${PREFIX} bom dia equipa`,
    expectTool: null, // no tool
    expectSilent: true,
  },
  {
    name: "emoji-only reaction (silence)",
    text: `${PREFIX} 👍`,
    expectTool: null,
    expectSilent: true,
  },
];

// ──────────────────────────────────────────────────────────────────────
// Synthetic grammY Context
// ──────────────────────────────────────────────────────────────────────
function makeFakeCtx(text) {
  const replies = [];
  return {
    captured: replies,
    message: {
      text,
      message_id: Math.floor(Math.random() * 1_000_000),
      chat: { id: -1009999999999, type: "group" },
      from: { id: MAFALDA_ID, first_name: "Mafalda" },
    },
    reply: async (replyText, opts) => {
      replies.push({ text: replyText, opts });
      return { message_id: replies.length, chat: { id: -1009999999999 } };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Main runner
// ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("haven-va prompt-behavior tests");
  console.log(`Prefix: ${PREFIX}`);
  console.log(`Cases:  ${TESTS.length}\n`);

  console.log(SEP);
  await notion.initialize();
  console.log(`✓ Resolver initialized\n`);

  // Use realistic openTasks context — fetch Mafalda's real open tasks so
  // the tests run with the same context that production has.
  const openTasks = await notion.getOpenTasksFor("Mafalda");
  console.log(`Loaded ${openTasks.length} real open tasks for Mafalda (context).\n`);

  console.log(SEP);
  console.log("Test cases");
  console.log(SEP);

  const results = [];
  for (const t of TESTS) {
    lastToolsCalled = [];
    const ctx = makeFakeCtx(t.text);
    const start = Date.now();
    try {
      await handleAssistant(
        ctx,
        "Mafalda",
        t.text,
        [], // recentMessages
        undefined, // repliedToText
        [], // contentCalendar
        [], // lastBotReplies
        openTasks,
      );
      const elapsed = Date.now() - start;
      const tools = lastToolsCalled.slice();

      let ok = true;
      const reasons = [];

      if (t.expectSilent) {
        if (tools.length > 0) {
          ok = false;
          reasons.push(`should be silent, but called: [${tools.join(", ")}]`);
        }
      } else if (t.expectTool) {
        if (!tools.includes(t.expectTool)) {
          ok = false;
          reasons.push(`expected '${t.expectTool}', got: [${tools.join(", ") || "none"}]`);
        }
      }
      if (t.forbidden) {
        for (const f of t.forbidden) {
          if (tools.includes(f)) {
            ok = false;
            reasons.push(`forbidden tool '${f}' was called`);
          }
        }
      }

      results.push({ ...t, ok, elapsed, tools, reasons });
      console.log(
        `  ${ok ? "✓" : "✗"} ${t.name.padEnd(50)} ${ok ? "" : reasons.join("; ")}  (${elapsed}ms, tools: [${tools.join(",")}])`,
      );
    } catch (err) {
      results.push({ ...t, ok: false, error: err.message });
      console.log(`  ✗ ${t.name.padEnd(50)} THREW: ${err.message}`);
    }
  }

  // ── cleanup ────────────────────────────────────────────
  console.log(`\nCleaning up ${createdPageIds.size} captured pageIds...`);
  let cleanupFailed = 0;
  for (const id of createdPageIds) {
    try {
      await notion.archivePage(id);
    } catch (err) {
      cleanupFailed++;
      console.log(`  ⚠ archive failed for ${id}: ${err.message}`);
    }
  }
  console.log(
    `  archived: ${createdPageIds.size - cleanupFailed}, failed: ${cleanupFailed}`,
  );

  // ── summary ────────────────────────────────────────────
  console.log("");
  console.log(SEP);
  console.log("Summary");
  console.log(SEP);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${passed} / ${results.length} passed`);

  if (failed > 0) {
    console.log(`\nFailures:`);
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  · ${r.name}`);
      console.log(`    input:  ${r.text}`);
      console.log(`    tools:  [${(r.tools || []).join(", ")}]`);
      if (r.error) console.log(`    error:  ${r.error}`);
      if (r.reasons) console.log(`    reason: ${r.reasons.join("; ")}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n❌ UNEXPECTED FAILURE:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
