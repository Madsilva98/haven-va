/**
 * One-shot setup script — adds the schema to the Notion DBs.
 * Idempotent: re-running it on a partially-set-up DB is safe; Notion's
 * `databases.update` adds new properties and merges select-option lists.
 *
 * Usage:
 *   node scripts/setup-notion-dbs.mjs
 *
 * Requires NOTION_API_KEY + the DB ids in .env (loaded by `node --env-file`).
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

const BACKLOG_DB_ID          = process.env.NOTION_BACKLOG_DB_ID;
const FOUNDER_FOCUS_DB_ID    = process.env.NOTION_FOUNDER_FOCUS_DB_ID;
const PARTNER_DB_ID          = process.env.NOTION_PARTNER_DB_ID;
const INFLUENCER_DB_ID       = process.env.NOTION_INFLUENCER_DB_ID;
const SUPPLIER_DB_ID         = process.env.NOTION_SUPPLIER_DB_ID;
const TO_DISCUSS_DB_ID       = process.env.NOTION_TO_DISCUSS_DB_ID;
const DECISIONS_DB_ID        = process.env.NOTION_DECISIONS_DB_ID;
const STUDIO_LOG_DB_ID       = process.env.NOTION_STUDIO_LOG_DB_ID;
const REMINDERS_DB_ID        = process.env.NOTION_REMINDERS_DB_ID;
const PROJECTS_DB_ID         = process.env.NOTION_PROJECTS_DB_ID;
const EVENTS_DB_ID           = process.env.NOTION_EVENT_DB_ID;
const LISTS_DB_ID            = process.env.NOTION_LISTS_DB_ID;
const LEADS_DB_ID            = process.env.NOTION_LEADS_DB_ID;
const CHURN_RISK_DB_ID       = process.env.NOTION_CHURN_RISK_DB_ID;
const COMPETITOR_SOURCES_DB_ID = process.env.NOTION_COMPETITOR_SOURCES_DB_ID;
const COMPETITOR_INTEL_DB_ID   = process.env.NOTION_COMPETITOR_INTEL_DB_ID;

if (!BACKLOG_DB_ID) {
  console.error("missing NOTION_BACKLOG_DB_ID env var — fill .env first");
  process.exit(1);
}

const OWNER_OPTIONS = [
  { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" }, { name: "Unassigned" },
];
const FOUNDER_OPTIONS = [
  { name: "Madalena" }, { name: "Mafalda" }, { name: "Beatriz" },
];
const AREA_OPTIONS = [
  { name: "Marketing" }, { name: "Operações" }, { name: "Parcerias" },
  { name: "Influencers" }, { name: "Tech" }, { name: "Cliente" },
  { name: "Financeiro" }, { name: "Outro" },
];

// ── Master Backlog ──────────────────────────────────────────────────────────
// Title property is "Título". First run renames Notion's default "Name" → "Título".
const backlogProperties = {
  Owner: { select: { options: OWNER_OPTIONS } },
  Área: { select: { options: AREA_OPTIONS } },
  Prioridade: { select: { options: [
    { name: "Alta" }, { name: "Média" }, { name: "Baixa" },
  ] } },
  Deadline: { date: {} },
  Status: { select: { options: [
    { name: "A fazer" }, { name: "Em curso" }, { name: "Bloqueado" },
    { name: "Feito" }, { name: "Cancelado" },
  ] } },
  Origem: { rich_text: {} },
  "Criado em": { created_time: {} },
  Semana: { formula: { expression: 'concat("Semana ", formatDate(prop("Criado em"), "W"))' } },
  "Prioridade semanal": { checkbox: {} },
};

// ── Reminders ───────────────────────────────────────────────────────────────
// Title property is "Reminder".
const remindersProperties = {
  "Para quem": { multi_select: { options: FOUNDER_OPTIONS } },
  Quando: { date: {} },
  Origem: { rich_text: {} },
  Enviado: { checkbox: {} },
  Feito: { checkbox: {} },
  Recorrência: { select: { options: [] } }, // options created dynamically at runtime
};

// ── Founder Focus ────────────────────────────────────────────────────────────
// Title property is "Nome" (bot sets it to "Objetivos {Founder} W{semana}").
// Weekly performance tracker: um row por founder por semana. "Objetivos"
// guarda os weekly goals (accionáveis — apresentar, fazer, terminar); "Cumprido"
// é escrito pelo bot no fecho de ciclo (domingo/segunda) quando respondido, senão
// fica por preencher manualmente; "Comentários" idem quando a resposta é "Não".
const founderFocusProperties = {
  Founder: { select: { options: FOUNDER_OPTIONS } },
  // "Semana" is a plain number (ISO week) written by the bot on every create.
  Semana: { number: {} },
  Objetivos: { rich_text: {} },
  Ativo: { checkbox: {} },
  Origem: { rich_text: {} },
  Cumprido: { select: { options: [{ name: "Sim" }, { name: "Não" }] } },
  Comentários: { rich_text: {} },
};

// ── Partner Pipeline ─────────────────────────────────────────────────────────
const partnerProperties = {
  Categoria: { select: { options: [
    { name: "Corporate" }, { name: "Eventos" }, { name: "Parceria" },
  ] } },
  Owner: { select: { options: OWNER_OPTIONS } },
  Status: { select: { options: [
    { name: "A contactar" }, { name: "Contactado" },
    { name: "A aguardar resposta" }, { name: "Em negociação" }, { name: "On hold" },
    { name: "Fechado" }, { name: "Arquivado" },
  ] } },
  "Último contacto": { date: {} },
  "Próximo passo": { rich_text: {} },
  Notas: { rich_text: {} },
  Email: { email: {} },
  Origem: { rich_text: {} },
  "Criado em": { created_time: {} },
};

// ── Influencer Pipeline ──────────────────────────────────────────────────────
const influencerProperties = {
  Instagram: { url: {} },
  Nicho: { rich_text: {} },
  "Seguidores (aprox.)": { select: { options: [
    { name: "<5k" }, { name: "5k - 20k" }, { name: "20k - 100k" }, { name: ">100k" },
  ] } },
  Owner: { select: { options: OWNER_OPTIONS } },
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
  Email: { email: {} },
  Origem: { rich_text: {} },
  "Criado em": { created_time: {} },
};

// ── Fornecedores ─────────────────────────────────────────────────────────────
// Added 2026-09-22 — vendor/supplier sales pitches (Instagram + email),
// previously dropped as noise, now tracked here. "Canal de contacto"
// includes "WhatsApp" even though no WhatsApp channel writes here yet
// (Meta verification still blocked) — future-proofs the schema.
const supplierProperties = {
  Owner: { select: { options: OWNER_OPTIONS } },
  Status: { select: { options: [
    { name: "A avaliar" }, { name: "Fornecedor atual" }, { name: "On hold" }, { name: "Arquivado" },
  ] } },
  "Canal de contacto": { select: { options: [
    { name: "Instagram DM" }, { name: "Email" }, { name: "WhatsApp" }, { name: "Outro" },
  ] } },
  "Último contacto": { date: {} },
  "Próximo passo": { rich_text: {} },
  Notas: { rich_text: {} },
  Email: { email: {} },
  Origem: { rich_text: {} },
  "Criado em": { created_time: {} },
};

// ── To Discuss ───────────────────────────────────────────────────────────────
// Title property is "Tema".
const toDiscussProperties = {
  "Adicionado por": { select: { options: FOUNDER_OPTIONS } },
  Urgência: { select: { options: [
    { name: "Próxima reunião" }, { name: "Decisão offline" }, { name: "Urgente" },
  ] } },
  Área: { select: { options: AREA_OPTIONS } },
  Estado: { select: { options: [
    { name: "Pendente" }, { name: "Discutido" }, { name: "Arquivado" },
  ] } },
  Resolução: { rich_text: {} },
  Deadline: { date: {} },
  Origem: { rich_text: {} },
  Data: { created_time: {} },
};

// ── Decisions ────────────────────────────────────────────────────────────────
// Title property is "Decisão".
const decisionsProperties = {
  Área: { select: { options: AREA_OPTIONS } },
  "Tomada por": { multi_select: { options: FOUNDER_OPTIONS } },
  Data: { date: {} },
  Estado: { select: { options: [
    { name: "Pendente implementação" }, { name: "Implementada" },
  ] } },
  Notas: { rich_text: {} },
  Origem: { rich_text: {} },
};

// ── Studio Log ───────────────────────────────────────────────────────────────
// Title property is "Nome". Captures events/status updates that don't need a backlog task.
const studioLogProperties = {
  Data: { date: {} },
  Owner: { select: { options: FOUNDER_OPTIONS } },
  Tags: { multi_select: { options: [] } },
  Origem: { rich_text: {} },
};

// ── Projetos ─────────────────────────────────────────────────────────────────
// Title property is "Name".
const projectsProperties = {
  Owner: { multi_select: { options: OWNER_OPTIONS } },
  Notas: { rich_text: {} },
  Status: { status: { options: [
    { name: "Not started" }, { name: "In progress" }, { name: "Done" },
  ] } },
  Área: { select: { options: AREA_OPTIONS } },
  "Data de início": { date: {} },
  Deadline: { date: {} },
  Origem: { rich_text: {} },
};

// ── Eventos ──────────────────────────────────────────────────────────────────
// Title property is "Name".
const eventsProperties = {
  Owner: { multi_select: { options: OWNER_OPTIONS } },
  Status: { status: { options: [
    { name: "Ideia" }, { name: "A planear" }, { name: "Confirmado" },
    { name: "Em preparação" }, { name: "Realizado" }, { name: "Cancelado" },
  ] } },
  Data: { date: {} },
  Notas: { rich_text: {} },
  "Próximo passo": { rich_text: {} },
  Tipo: { select: { options: [
    { name: "Aula" }, { name: "Evento" }, { name: "Co-branded" }, { name: "Workshop" },
  ] } },
  Origem: { rich_text: {} },
};

// ── Listas ───────────────────────────────────────────────────────────────────
// Title property is "Item".
// "Lista" is deliberately NOT included here: it's a select whose options are
// created dynamically at runtime (one per distinct list name). Pushing
// `{ select: { options: [] } }` through dataSources.update REPLACES the full
// option list with empty — Notion then clears that property on every page
// referencing a now-deleted option. Happened once (2026-09-07): wiped every
// card's "Lista" value repo-wide. Never include this property in a schema
// push; if the select itself needs to exist for the first time, create it
// via the Notion UI once, then leave it alone here.
const listasProperties = {
  Fechada: { checkbox: {} },
  "Adicionado por": { select: { options: FOUNDER_OPTIONS } },
  Origem: { rich_text: {} },
};

// ── Leads a contactar ────────────────────────────────────────────────────────
// Title property is "Nome". Fed by src/crons/leads-email-scan.ts (Canal=Email)
// and src/crons/leads-intro-pack.ts (Canal="Intro Pack"); WhatsApp/Instagram
// values are reserved for the still-blocked Meta webhook path.
const leadsProperties = {
  Email: { email: {} },
  Telefone: { phone_number: {} },
  Canal: { select: { options: [
    { name: "Email" }, { name: "WhatsApp" }, { name: "Instagram" }, { name: "Intro Pack" },
  ] } },
  Motivo: { rich_text: {} },
  Pack: { rich_text: {} },
  "Última visita": { date: {} },
  "Nº de visitas": { number: {} },
  "Verificação": { select: { options: [
    { name: "Sem correspondência" }, { name: "Match incerto — rever manualmente" }, { name: "N/A" },
  ] } },
  Estado: { select: { options: [
    { name: "Novo" }, { name: "Contactado" }, { name: "Convertido" }, { name: "Perdido" },
    { name: "Inconclusivo" },
  ] } },
  Notas: { rich_text: {} },
  Origem: { rich_text: {} },
  "Criado em": { created_time: {} },
  // "Mensagem" (the raw email excerpt) was removed 2026-09-16 — "Motivo" +
  // "Origem" carry enough context, founder didn't need it. Deleted via a
  // one-off `Mensagem: null` push; NOT left in permanently — the Notion API
  // 404s (doesn't silently no-op) if you try to null a property that's
  // already gone, which would break every future run of this script.
};

// ── Clientes em risco de churn ──────────────────────────────────────────────
// Title property is "Nome". Fed by src/crons/churn-risk.ts.
const churnRiskProperties = {
  Email: { email: {} },
  Telefone: { phone_number: {} },
  Plano: { rich_text: {} },
  Sinais: { multi_select: { options: [
    { name: "Sem reservas 14+ dias" }, { name: "Pagamento falhado" }, { name: "Baixa utilização" },
  ] } },
  Detalhes: { rich_text: {} },
  Status: { select: { options: [
    { name: "Aberto" }, { name: "Contactado" }, { name: "Resolvido" }, { name: "Arquivado" },
  ] } },
  "Última deteção": { date: {} },
  "Criado em": { created_time: {} },
};

// ── Fontes Concorrência/Inspiração ──────────────────────────────────────────
// Founder-maintained sender list driving the competitor-intel Gmail tidy step.
const competitorSourcesProperties = {
  "Email/Domínio": { rich_text: {} },
  Categoria: { select: { options: [
    { name: "Concorrência" }, { name: "Inspiração" },
  ] } },
  Ativo: { checkbox: {} },
};

// ── Competitor Intel ─────────────────────────────────────────────────────────
// "Tipo" is intentionally omitted — it's a multi-select whose options grow
// dynamically as the extractor proposes new tags; including it here with a
// fixed (or empty) options list would wipe any options not listed on every
// run (see docs/knowledge-base/notion-api-gotchas.md TL;DR item 8).
// "Categoria" is left for the founder to set by hand, so it's also omitted
// here — set it up manually in Notion with Concorrência/Inspiração options.
const competitorIntelProperties = {
  Fonte: { rich_text: {} },
  Resumo: { rich_text: {} },
  "Data do email": { date: {} },
  "Assunto do email": { rich_text: {} },
  Link: { url: {} },
};

async function setup(label, dbId, props) {
  console.log(`\n→ ${label} (${dbId})`);
  try {
    // As of API version 2025-09-03, schema lives on the database's data source,
    // not the database itself — databases.update no longer accepts `properties`.
    const db = await notion.databases.retrieve({ database_id: dbId });
    const dataSources = db.data_sources ?? [];
    if (dataSources.length !== 1) {
      throw new Error(
        `expected exactly 1 data source, found ${dataSources.length} (${dataSources.map((d) => d.name).join(", ")})`,
      );
    }
    const res = await notion.dataSources.update({
      data_source_id: dataSources[0].id,
      properties: props,
    });
    const propNames = Object.keys(res.properties);
    console.log(`  ok — has ${propNames.length} properties: ${propNames.join(", ")}`);
  } catch (err) {
    console.error(`  fail —`, err.body ?? err.message);
    process.exitCode = 1;
  }
}

async function main() {
  await setup("Master Backlog", BACKLOG_DB_ID, backlogProperties);

  if (REMINDERS_DB_ID)        await setup("Reminders",        REMINDERS_DB_ID,        remindersProperties);
  else console.log("\n· Reminders DB id not set — skipping");
  if (FOUNDER_FOCUS_DB_ID)    await setup("Founder Focus",    FOUNDER_FOCUS_DB_ID,    founderFocusProperties);
  else console.log("· Founder Focus DB id not set — skipping");
  if (PARTNER_DB_ID)          await setup("Partner Pipeline", PARTNER_DB_ID,          partnerProperties);
  else console.log("· Partner Pipeline DB id not set — skipping");
  if (INFLUENCER_DB_ID)       await setup("Influencer Pipeline", INFLUENCER_DB_ID,    influencerProperties);
  else console.log("· Influencer Pipeline DB id not set — skipping");
  if (SUPPLIER_DB_ID)         await setup("Fornecedores",      SUPPLIER_DB_ID,         supplierProperties);
  else console.log("· Fornecedores DB id not set — skipping");
  if (TO_DISCUSS_DB_ID)       await setup("To Discuss",       TO_DISCUSS_DB_ID,       toDiscussProperties);
  else console.log("· To Discuss DB id not set — skipping");
  if (DECISIONS_DB_ID)        await setup("Decisions",        DECISIONS_DB_ID,        decisionsProperties);
  else console.log("· Decisions DB id not set — skipping");
  if (STUDIO_LOG_DB_ID)       await setup("Studio Log",       STUDIO_LOG_DB_ID,       studioLogProperties);
  else console.log("· Studio Log DB id not set — skipping");
  if (PROJECTS_DB_ID)         await setup("Projetos",         PROJECTS_DB_ID,         projectsProperties);
  else console.log("· Projetos DB id not set — skipping");
  if (EVENTS_DB_ID)           await setup("Eventos",          EVENTS_DB_ID,           eventsProperties);
  else console.log("· Eventos DB id not set — skipping");
  if (LISTS_DB_ID)            await setup("Listas",           LISTS_DB_ID,            listasProperties);
  else console.log("· Listas DB id not set — skipping");
  if (LEADS_DB_ID)            await setup("Leads a contactar", LEADS_DB_ID,           leadsProperties);
  else console.log("· Leads a contactar DB id not set — skipping");
  if (CHURN_RISK_DB_ID)       await setup("Clientes em risco", CHURN_RISK_DB_ID,      churnRiskProperties);
  else console.log("· Clientes em risco DB id not set — skipping");
  if (COMPETITOR_SOURCES_DB_ID) await setup("Fontes Concorrência/Inspiração", COMPETITOR_SOURCES_DB_ID, competitorSourcesProperties);
  else console.log("· Fontes Concorrência/Inspiração DB id not set — skipping");
  if (COMPETITOR_INTEL_DB_ID)   await setup("Competitor Intel", COMPETITOR_INTEL_DB_ID, competitorIntelProperties);
  else console.log("· Competitor Intel DB id not set — skipping");
}

main().catch((err) => {
  console.error("setup failed:", err);
  process.exit(1);
});
