/**
 * One-shot setup script — adds the Phase 1 schema to the 3 Notion DBs.
 * Idempotent: re-running it on a partially-set-up DB is safe; Notion's
 * `databases.update` adds new properties and merges select-option lists.
 *
 * Usage:
 *   node scripts/setup-notion-dbs.mjs
 *
 * Requires NOTION_API_KEY + the 3 DB ids in .env (loaded by `node --env-file`).
 */

import { Client } from "@notionhq/client";

const envFile = ".env";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const BACKLOG_DB_ID = process.env.NOTION_BACKLOG_DB_ID;
const FEEDBACK_DB_ID = process.env.NOTION_FEEDBACK_DB_ID;
const PENDING_DB_ID = process.env.NOTION_PENDING_DB_ID;
const FOUNDER_FOCUS_DB_ID = process.env.NOTION_FOUNDER_FOCUS_DB_ID;
const PARTNER_DB_ID = process.env.NOTION_PARTNER_DB_ID;
const INFLUENCER_DB_ID = process.env.NOTION_INFLUENCER_DB_ID;
const TO_DISCUSS_DB_ID = process.env.NOTION_TO_DISCUSS_DB_ID;
const DECISIONS_DB_ID = process.env.NOTION_DECISIONS_DB_ID;
const STUDIO_LOG_DB_ID = process.env.NOTION_STUDIO_LOG_DB_ID;

if (!BACKLOG_DB_ID || !FEEDBACK_DB_ID || !PENDING_DB_ID) {
  console.error("missing core NOTION_*_DB_ID env vars — fill .env first");
  process.exit(1);
}

const palette = "default"; // Notion picks reasonable colors automatically

// ── Master Backlog ──────────────────────────────────────────────────────────
// Note: title property must be named "Título". The bot writes to it.
// First run of this script also renames Notion's default "Name" → "Título";
// re-runs are no-ops because the DB already has "Título".
const backlogProperties = {
  Owner: {
    select: {
      options: [
        { name: "Madalena" },
        { name: "Mafalda" },
        { name: "Beatriz" },
        { name: "Unassigned" },
      ],
    },
  },
  Área: {
    select: {
      options: [
        { name: "Marketing" },
        { name: "Operações" },
        { name: "Parcerias" },
        { name: "Influencers" },
        { name: "Tech" },
        { name: "Cliente" },
        { name: "Financeiro" },
        { name: "Outro" },
      ],
    },
  },
  Prioridade: {
    select: {
      options: [
        { name: "Alta" },
        { name: "Média" },
        { name: "Baixa" },
      ],
    },
  },
  Deadline: { date: {} },
  Status: {
    select: {
      options: [
        { name: "A fazer" },
        { name: "Em curso" },
        { name: "Bloqueado" },
        { name: "Feito" },
        { name: "Cancelado" },
      ],
    },
  },
  Notas: { rich_text: {} },
  "Criado em": { created_time: {} },
  Semana: {
    formula: {
      expression: 'concat("Semana ", formatDate(prop("Criado em"), "W"))',
    },
  },
  "Prioridade semanal": { checkbox: {} },
};

// ── Bot Feedback ────────────────────────────────────────────────────────────
const feedbackProperties = {
  Tipo: {
    select: {
      options: [
        { name: "confirmed" },
        { name: "false_positive" },
        { name: "correction" },
      ],
    },
  },
  "Mensagem original": { rich_text: {} },
  Sender: {
    select: {
      options: [
        { name: "Madalena" },
        { name: "Mafalda" },
        { name: "Beatriz" },
      ],
    },
  },
  "Bot extraction": { rich_text: {} },
  "Tua acção": {
    select: {
      // The bot creates new options dynamically as it sees new actions.
      // We seed the common ones.
      options: [
        { name: "priority:Alta" },
        { name: "priority:Média" },
        { name: "priority:Baixa" },
        { name: "❌ ignorar" },
        { name: "✅ atualiza" },
        { name: "❌ deixa" },
        { name: "reply" },
      ],
    },
  },
  "Texto da correcção": { rich_text: {} },
  Data: { created_time: {} },
};

// ── Bot Pending ─────────────────────────────────────────────────────────────
const pendingProperties = {
  "Bot Message ID": { number: { format: "number" } },
  Tipo: {
    select: {
      options: [
        { name: "new_task" },
        { name: "edit" },
      ],
    },
  },
  Extraction: { rich_text: {} },
  "Mensagem original": { rich_text: {} },
  Sender: {
    select: {
      options: [
        { name: "Madalena" },
        { name: "Mafalda" },
        { name: "Beatriz" },
      ],
    },
  },
  "Created at": { created_time: {} },
  // Multi-intent additions (2026-05-01) — chat-scoped recent-actions buffer
  "Chat ID": { number: { format: "number" } },
  Committed: { checkbox: {} },
  Cancelled: { checkbox: {} },
  "Notion Page ID": { rich_text: {} },
};

async function setup(label, dbId, props) {
  console.log(`\n→ ${label} (${dbId})`);
  try {
    const res = await notion.databases.update({
      database_id: dbId,
      properties: props,
    });
    const propNames = Object.keys(res.properties);
    console.log(`  ok — has ${propNames.length} properties: ${propNames.join(", ")}`);
  } catch (err) {
    console.error(`  fail —`, err.body ?? err.message);
    process.exitCode = 1;
  }
}

// ── Founder Focus (Phase 2) ──────────────────────────────────────────────────
const founderFocusProperties = {
  Founder: { select: { options: [
    { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" },
  ] } },
  Semana: { rich_text: {} },
  "Foco operacional": { rich_text: {} },
  "Atualizado em": { last_edited_time: {} },
};

// ── Partner Pipeline (Phase 3, brief §9.3) ───────────────────────────────────
const partnerProperties = {
  Categoria: { select: { options: [
    { name: "Corporate" }, { name: "Eventos" }, { name: "Parceria" },
  ] } },
  Owner: { select: { options: [
    { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" },
  ] } },
  Status: { select: { options: [
    { name: "A contactar" }, { name: "Contactado" },
    { name: "A aguardar resposta" }, { name: "Em negociação" },
    { name: "Fechado" }, { name: "Arquivado" },
  ] } },
  "Último contacto": { date: {} },
  "Próximo passo": { rich_text: {} },
  "One-pager enviado": { select: { options: [
    { name: "Corporate PT" }, { name: "Corporate ENG" },
    { name: "Eventos PT" }, { name: "Eventos ENG" },
    { name: "Parceria PT" }, { name: "Parceria ENG" },
    { name: "Nenhum" },
  ] } },
  Contacto: { email: {} },
  Notas: { rich_text: {} },
  "Criado em": { created_time: {} },
};

// ── Influencer Pipeline (Phase 3, brief §9.4) ────────────────────────────────
const influencerProperties = {
  Instagram: { url: {} },
  Nicho: { multi_select: { options: [
    { name: "Fitness" }, { name: "Lifestyle" }, { name: "Maternidade" },
    { name: "Nutrição" }, { name: "Bem-estar" }, { name: "Outro" },
  ] } },
  "Seguidores (aprox.)": { select: { options: [
    { name: "<5k" }, { name: "5k-20k" }, { name: "20k-100k" }, { name: "+100k" },
  ] } },
  Owner: { select: { options: [
    { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" },
  ] } },
  Status: { select: { options: [
    { name: "A identificar" }, { name: "A contactar" }, { name: "Contactado" },
    { name: "Em conversa" }, { name: "Proposta enviada" },
    { name: "Fechado" }, { name: "Arquivado" },
  ] } },
  "Canal de contacto": { select: { options: [
    { name: "Instagram DM" }, { name: "Email" }, { name: "Outro" },
  ] } },
  "Último contacto": { date: {} },
  "Próximo passo": { rich_text: {} },
  "Tipo de colaboração": { multi_select: { options: [
    { name: "Visita ao estúdio" }, { name: "Post patrocinado" },
    { name: "Parceria de longo prazo" }, { name: "Evento" }, { name: "Outro" },
  ] } },
  Notas: { rich_text: {} },
  "Criado em": { created_time: {} },
};

// ── To Discuss (Phase 5, brief §9.5) ─────────────────────────────────────────
const toDiscussProperties = {
  "Adicionado por": { select: { options: [
    { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" },
  ] } },
  Urgência: { select: { options: [
    { name: "Pode esperar" }, { name: "Precisa de decisão rápida" }, { name: "Urgente" },
  ] } },
  Área: { select: { options: [
    { name: "Marketing" }, { name: "Operações" }, { name: "Financeiro" },
    { name: "RH" }, { name: "Estratégia" }, { name: "Outro" },
  ] } },
  Estado: { select: { options: [
    { name: "Pendente" }, { name: "Discutido" }, { name: "Arquivado" },
  ] } },
  Data: { created_time: {} },
  Resolução: { rich_text: {} },
};

// ── Decisions (Phase 5, brief §9.6) ──────────────────────────────────────────
const decisionsProperties = {
  Área: { select: { options: [
    { name: "Marketing" }, { name: "Operações" }, { name: "Financeiro" },
    { name: "RH" }, { name: "Estratégia" }, { name: "Outro" },
  ] } },
  "Tomada por": { multi_select: { options: [
    { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" },
  ] } },
  Data: { date: {} },
  Estado: { select: { options: [
    { name: "Pendente implementação" }, { name: "Implementada" },
  ] } },
  Notas: { rich_text: {} },
};

// ── Studio Log (Phase 1 redesign, 2026-05-01) ────────────────────────────────
// Captures status updates / events that don't need a backlog task —
// e.g. "Madalena enviou pedido de vistoria à CMC". Title property is "Texto".
const studioLogProperties = {
  Data: { date: {} },
  Autor: {
    select: {
      options: [
        { name: "Madalena" },
        { name: "Mafalda" },
        { name: "Beatriz" },
      ],
    },
  },
  Tags: { multi_select: { options: [] } },
  "Mensagem original": { rich_text: {} },
};

async function main() {
  await setup("Master Backlog", BACKLOG_DB_ID, backlogProperties);
  await setup("Bot Feedback", FEEDBACK_DB_ID, feedbackProperties);
  await setup("Bot Pending", PENDING_DB_ID, pendingProperties);

  if (FOUNDER_FOCUS_DB_ID) await setup("Founder Focus", FOUNDER_FOCUS_DB_ID, founderFocusProperties);
  else console.log("\n· Founder Focus DB id not set — skipping (Phase 2)");
  if (PARTNER_DB_ID) await setup("Partner Pipeline", PARTNER_DB_ID, partnerProperties);
  else console.log("· Partner Pipeline DB id not set — skipping (Phase 3)");
  if (INFLUENCER_DB_ID) await setup("Influencer Pipeline", INFLUENCER_DB_ID, influencerProperties);
  else console.log("· Influencer Pipeline DB id not set — skipping (Phase 3)");
  if (TO_DISCUSS_DB_ID) await setup("To Discuss", TO_DISCUSS_DB_ID, toDiscussProperties);
  else console.log("· To Discuss DB id not set — skipping (Phase 5)");
  if (DECISIONS_DB_ID) await setup("Decisions", DECISIONS_DB_ID, decisionsProperties);
  else console.log("· Decisions DB id not set — skipping (Phase 5)");
  if (STUDIO_LOG_DB_ID) await setup("Studio Log", STUDIO_LOG_DB_ID, studioLogProperties);
  else console.log("· Studio Log DB id not set — skipping (Phase 1 redesign)");

  console.log(`\nDone. To activate Phase 2/3/5 DBs:
  1. Create empty Notion DBs for the missing ones above
  2. Share each with the "Haven Ops" integration
  3. Paste DB ids into .env (NOTION_FOUNDER_FOCUS_DB_ID, NOTION_PARTNER_DB_ID,
     NOTION_INFLUENCER_DB_ID, NOTION_TO_DISCUSS_DB_ID, NOTION_DECISIONS_DB_ID)
  4. Re-run this script — it'll add the schemas
  5. Push env to Vercel: node scripts/push-env-to-vercel.mjs
`);
}

main().catch((err) => {
  console.error("setup failed:", err);
  process.exit(1);
});
