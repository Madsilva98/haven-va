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

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const BACKLOG_DB_ID          = process.env.NOTION_BACKLOG_DB_ID;
const FOUNDER_FOCUS_DB_ID    = process.env.NOTION_FOUNDER_FOCUS_DB_ID;
const PARTNER_DB_ID          = process.env.NOTION_PARTNER_DB_ID;
const INFLUENCER_DB_ID       = process.env.NOTION_INFLUENCER_DB_ID;
const TO_DISCUSS_DB_ID       = process.env.NOTION_TO_DISCUSS_DB_ID;
const DECISIONS_DB_ID        = process.env.NOTION_DECISIONS_DB_ID;
const STUDIO_LOG_DB_ID       = process.env.NOTION_STUDIO_LOG_DB_ID;
const REMINDERS_DB_ID        = process.env.NOTION_REMINDERS_DB_ID;
const PROJECTS_DB_ID         = process.env.NOTION_PROJECTS_DB_ID;
const EVENTS_DB_ID           = process.env.NOTION_EVENT_DB_ID;
const LISTS_DB_ID            = process.env.NOTION_LISTS_DB_ID;
const CONTENT_CALENDAR_DB_ID = process.env.NOTION_CONTENT_CALENDAR_DB_ID;

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
// Title property is "Name" (bot sets it from foco operacional text).
const founderFocusProperties = {
  Founder: { select: { options: FOUNDER_OPTIONS } },
  // "Semana" is a formula in Notion — cannot be set via databases.update
  "Foco operacional": { rich_text: {} },
  Ativo: { checkbox: {} },
  Origem: { rich_text: {} },
};

// ── Partner Pipeline ─────────────────────────────────────────────────────────
const partnerProperties = {
  Categoria: { select: { options: [
    { name: "Corporate" }, { name: "Eventos" }, { name: "Parceria" },
  ] } },
  Owner: { select: { options: OWNER_OPTIONS } },
  Status: { select: { options: [
    { name: "A contactar" }, { name: "Contactado" },
    { name: "A aguardar resposta" }, { name: "Em negociação" },
    { name: "Fechado" }, { name: "Arquivado" },
  ] } },
  "Último contacto": { date: {} },
  "Próximo passo": { rich_text: {} },
  Notas: { rich_text: {} },
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
const listasProperties = {
  Lista: { select: { options: [] } }, // options created dynamically at runtime
  Fechada: { checkbox: {} },
  "Adicionado por": { select: { options: FOUNDER_OPTIONS } },
  Origem: { rich_text: {} },
};

// ── Content Calendar ──────────────────────────────────────────────────────────
// Title property is "Name". Date field is "Posting Haven" only.
const contentCalendarProperties = {
  "Posting Haven": { date: {} },
  "Ad type": { select: { options: [
    { name: "awareness" }, { name: "traffic" }, { name: "conversion" },
  ] } },
  Series: { select: { options: [
    { name: "Haven About" }, { name: "Haven Benefits" }, { name: "Haven Community" },
    { name: "Pilates Educational" }, { name: "Filler Studio" }, { name: "Filler Motivational" },
    { name: "Filler Relatable" }, { name: "Filler Funny" }, { name: "Customer Highlight" },
    { name: "Instructor Highlight" }, { name: "Funny & Relatable" },
    { name: "Day to day" }, { name: "About us" },
  ] } },
  Caption: { rich_text: {} },
  "Post URL": { url: {} },
  Script: { rich_text: {} },
  Clips: { rich_text: {} },
  Description: { rich_text: {} },
  "Inspo video": { rich_text: {} },
  "Recording date": { date: {} },
  Type: { multi_select: { options: [
    { name: "Haven" }, { name: "Ad" },
  ] } },
  "Active ad": { checkbox: {} },
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
  if (CONTENT_CALENDAR_DB_ID) await setup("Content Calendar", CONTENT_CALENDAR_DB_ID, contentCalendarProperties);
  else console.log("· Content Calendar DB id not set — skipping");
}

main().catch((err) => {
  console.error("setup failed:", err);
  process.exit(1);
});
