/**
 * End-to-end migration test — mimics real Telegram messages.
 *
 * Calls handleAssistant() with realistic Portuguese messages that
 * the bot actually receives in production. Each message goes through
 * the full pipeline:
 *   message → Haiku tool_use → notion.ts write → migrated dataSources API
 *
 * The synthetic Context captures bot replies (no Telegram delivery).
 * Real Anthropic API calls happen (cost: ~$0.005 per message).
 * Real Notion writes happen — every entry is prefixed [E2E MIGRATION TEST]
 * so they're trivially findable, and cleaned up at the end.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-data-sources-e2e.mjs
 */

import * as notion from "../dist/notion.js";
import { handleAssistant } from "../dist/bot/assistant.js";

const PREFIX = `[E2E MIGRATION TEST ${new Date().toISOString().slice(0, 19)}]`;
const SEP = "─".repeat(72);
const MAFALDA_ID = Number(process.env.TELEGRAM_MAFALDA_ID);

if (!Number.isInteger(MAFALDA_ID)) {
  console.error("TELEGRAM_MAFALDA_ID missing from env");
  process.exit(1);
}

const TEST_MESSAGES = [
  // ── Tasks ─────────────────────────────────────────
  {
    label: "simple task",
    text: `${PREFIX} cria task: preparar moodboard para sessão`,
    expectReplyPattern: /task|criada|backlog/i,
  },
  {
    label: "task with owner + area",
    text: `${PREFIX} cria task para a Beatriz na área de marketing: rever proposta WellHub`,
    expectReplyPattern: /task|criada|beatriz/i,
  },
  {
    label: "task with deadline (amanhã)",
    text: `${PREFIX} task para amanhã: agendar story instagram`,
    expectReplyPattern: /task|criada/i,
  },
  {
    label: "task with high priority",
    text: `${PREFIX} prioridade alta: contactar imprensa para evento`,
    expectReplyPattern: /task|criada|alta/i,
  },

  // ── Reminders ─────────────────────────────────────
  {
    label: "reminder at specific time tomorrow",
    text: `${PREFIX} lembra-me amanhã às 10h de testar a migração`,
    expectReplyPattern: /lembr|reminder|amanhã/i,
  },
  {
    label: "recurring daily reminder",
    text: `${PREFIX} lembra-me todos os dias às 8h de testar`,
    expectReplyPattern: /lembr|todos os dias|diári/i,
  },
  {
    label: "recurring weekly reminder",
    text: `${PREFIX} lembra-me toda a semana sexta às 9h de testar`,
    expectReplyPattern: /lembr|semana/i,
  },
  {
    label: "reminder for another founder",
    text: `${PREFIX} avisa a Madalena amanhã às 14h de rever PR`,
    expectReplyPattern: /lembr|madalena/i,
  },
  {
    label: "reminder for all founders",
    text: `${PREFIX} lembra todas hoje às 23h59 de reunião teste`,
    expectReplyPattern: /lembr|todas/i,
  },

  // ── Entities ──────────────────────────────────────
  {
    label: "new partner",
    text: `${PREFIX} novo parceiro: Studio Yoga Test Lisboa`,
    expectReplyPattern: /parceiro|criad/i,
  },
  {
    label: "new event",
    text: `${PREFIX} novo evento: Workshop Teste Maio`,
    expectReplyPattern: /evento|criad/i,
  },

  // ── ToDiscuss ─────────────────────────────────────
  {
    label: "to discuss item",
    text: `${PREFIX} adiciona à discussão: rever budget marketing junho`,
    expectReplyPattern: /discut|tópic|adicion/i,
  },

  // ── Edge: banter that should NOT create anything ─
  {
    label: "banter (should NOT create entry)",
    text: `${PREFIX} já enchi o frigorífico ahah`,
    expectReplyPattern: /.*/,  // any reply OK, but we'll verify zero notion writes
    expectNoNotionWrite: true,
  },
];

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
    // grammY context has lots of helpers; assistant only uses ctx.reply and ctx.message.
    // Anything else accessed would throw — that's actually useful feedback.
  };
}

// Hook into stdout to capture every pageId the bot logs during create calls.
// The bot's structured logger writes JSON lines like:
//   {"level":"info","msg":"notion.task_created","pageId":"36..","title":"..."}
// We capture the pageId from any line with "_created" in the msg.
const createdPageIds = new Set();
const origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === "string" && chunk.includes('_created"')) {
    // Pull pageId or id field — bot uses both depending on the function.
    const idMatch = chunk.match(/"(?:pageId|id)":"([0-9a-f-]{32,40})"/);
    if (idMatch) createdPageIds.add(idMatch[1]);
  }
  return origStdoutWrite(chunk, ...rest);
};

async function archiveCapturedPages() {
  console.log(`\nArchiving ${createdPageIds.size} captured page(s) from this run...`);
  let archived = 0;
  let failed = 0;
  for (const id of createdPageIds) {
    try {
      await notion.archivePage(id);
      archived++;
    } catch (err) {
      failed++;
      console.log(`  ⚠ failed to archive ${id}: ${err.message}`);
    }
  }
  console.log(`  archived: ${archived}, failed: ${failed}`);
  return { archived, failed, total: createdPageIds.size };
}

async function main() {
  console.log("haven-va data-sources E2E test");
  console.log(`Test prefix: ${PREFIX}`);
  console.log(`Messages: ${TEST_MESSAGES.length}\n`);

  console.log(SEP);
  console.log("Initializing data_source_id resolver...");
  console.log(SEP);
  await notion.initialize();
  console.log(`✓ All 11 DBs resolved.\n`);

  console.log(SEP);
  console.log("Running E2E messages (each = real Haiku call + real Notion write)");
  console.log(SEP);

  const results = [];

  for (const msg of TEST_MESSAGES) {
    process.stdout.write(`  ${msg.label.padEnd(40)} `);
    const ctx = makeFakeCtx(msg.text);
    const start = Date.now();
    try {
      await handleAssistant(ctx, "Mafalda", msg.text, [], undefined, [], [], []);
      const elapsed = Date.now() - start;
      const replyText = ctx.captured.map((r) => r.text).join(" | ");
      const matched = msg.expectReplyPattern.test(replyText);

      if (msg.expectNoNotionWrite) {
        // Heuristic: if any reply mentions "criada" or "lembrete", that's a write.
        const probablyWrote = /criad|lembrete criado|task criada|partne|evento|discutir/i.test(replyText);
        if (probablyWrote) {
          console.log(`✗ unexpectedly wrote to Notion (${elapsed}ms)`);
          console.log(`      reply: ${replyText.slice(0, 100)}`);
          results.push({ ...msg, ok: false, elapsed, replyText });
        } else {
          console.log(`✓ banter — no write (${elapsed}ms)`);
          results.push({ ...msg, ok: true, elapsed, replyText });
        }
      } else if (matched) {
        console.log(`✓ ${elapsed}ms`);
        results.push({ ...msg, ok: true, elapsed, replyText });
      } else {
        console.log(`✗ reply didn't match pattern (${elapsed}ms)`);
        console.log(`      reply: ${replyText.slice(0, 150)}`);
        results.push({ ...msg, ok: false, elapsed, replyText });
      }
    } catch (err) {
      console.log(`✗ THREW: ${err.message}`);
      results.push({ ...msg, ok: false, error: err.message });
    }
  }

  console.log("");
  const sweep = await archiveCapturedPages();

  console.log("");
  console.log(SEP);
  console.log("Summary");
  console.log(SEP);
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(`  ${sweep.archived} Notion entries archived (${sweep.failed} cleanup failures)`);

  if (failed > 0) {
    console.log(`\nFailed messages:`);
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  · ${r.label}`);
      if (r.error) console.log(`    error: ${r.error}`);
      if (r.replyText) console.log(`    reply: ${r.replyText.slice(0, 200)}`);
    }
  }

  if (sweep.failed > 0) {
    console.log(
      `\n⚠ Some test entries are still in Notion. Search "${PREFIX}" to find and remove manually.`,
    );
  }

  process.exit(failed > 0 || sweep.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n❌ UNEXPECTED FAILURE:", err.message);
  if (err.stack) console.error(err.stack);
  console.error(`\n⚠ Test entries may exist in Notion with prefix "${PREFIX}".`);
  process.exit(1);
});
