import XLSX from "xlsx";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "text" = nome no UI do Notion; "rich_text" = nome na Notion API (são a mesma coisa)

const dbs = [
  {
    sheet: "Backlog",
    envVar: "NOTION_BACKLOG_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Título", "title", "", ""],
      ["Status", "select", "A fazer | Em curso | Bloqueado | Feito | Cancelado", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Área", "select", "Marketing | Operações | Parcerias | Influencers | Tech | Cliente | Financeiro | Outro", ""],
      ["Prioridade", "select", "Alta | Média | Baixa", ""],
      ["Deadline", "date", "", "inclui hora"],
      ["Origem", "text", "", ""],
      ["Prioridade semanal", "checkbox", "", ""],
      ["Semana", "formula", "", "read-only"],
      ["Depende de", "relation", "", "→ própria DB"],
      ["Projects", "relation", "", "→ NOTION_PROJECTS_DB_ID"],
      ["Events Pipeline", "relation", "", "→ NOTION_EVENT_DB_ID"],
      ["Partner Pipeline", "relation", "", "→ NOTION_PARTNER_DB_ID"],
      ["Influencer Pipeline", "relation", "", "→ NOTION_INFLUENCER_DB_ID"],
      ["Com Reminder", "relation", "", "→ NOTION_REMINDERS_DB_ID"],
    ],
  },
  {
    sheet: "Reminders",
    envVar: "NOTION_REMINDERS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Reminder", "title", "", ""],
      ["Para quem", "multi_select", "Madalena | Mafalda | Beatriz", ""],
      ["Quando", "date", "", "inclui hora"],
      ["Origem", "text", "", ""],
      ["Enviado", "checkbox", "", "lembrete enviado por Telegram"],
      ["Feito", "checkbox", "", "founder confirmou que fez"],
      ["Recorrência", "select", "", "opções criadas dinamicamente (ex: diária, semanal, mensal, a cada 2 semanas)"],
      ["Da tarefa", "relation", "", "→ NOTION_BACKLOG_DB_ID"],
      ["Projects", "relation", "", "→ NOTION_PROJECTS_DB_ID"],
      ["Events Pipeline", "relation", "", "→ NOTION_EVENT_DB_ID"],
      ["Partner Pipeline", "relation", "", "→ NOTION_PARTNER_DB_ID"],
      ["Influencer Pipeline", "relation", "", "→ NOTION_INFLUENCER_DB_ID"],
    ],
  },
  {
    sheet: "Para Discutir",
    envVar: "NOTION_TO_DISCUSS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Tema", "title", "", ""],
      ["Adicionado por", "select", "Madalena | Mafalda | Beatriz", ""],
      ["Urgência", "select", "Próxima reunião | Decisão offline | Urgente", ""],
      ["Área", "select", "Marketing | Operações | Parcerias | Influencers | Tech | Cliente | Financeiro | Outro", ""],
      ["Estado", "select", "Pendente | Discutido | Arquivado", ""],
      ["Resolução", "text", "", ""],
      ["Deadline", "date", "", "opcional"],
      ["Origem", "text", "", ""],
      ["Data", "date", "", ""],
      ["Projects", "relation", "", "→ NOTION_PROJECTS_DB_ID"],
      ["Events Pipeline", "relation", "", "→ NOTION_EVENT_DB_ID"],
      ["Partner Pipeline", "relation", "", "→ NOTION_PARTNER_DB_ID"],
      ["Influencer Pipeline", "relation", "", "→ NOTION_INFLUENCER_DB_ID"],
    ],
  },
  {
    sheet: "Decisões",
    envVar: "NOTION_DECISIONS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Decisão", "title", "", ""],
      ["Área", "select", "Marketing | Operações | Parcerias | Influencers | Tech | Cliente | Financeiro | Outro", ""],
      ["Tomada por", "multi_select", "Madalena | Mafalda | Beatriz", ""],
      ["Estado", "select", "Implementada | Pendente implementação", ""],
      ["Notas", "text", "", ""],
      ["Origem", "text", "", ""],
      ["Data", "date", "", ""],
      ["Projects", "relation", "", "→ NOTION_PROJECTS_DB_ID"],
      ["Events Pipeline", "relation", "", "→ NOTION_EVENT_DB_ID"],
      ["Partner Pipeline", "relation", "", "→ NOTION_PARTNER_DB_ID"],
      ["Influencer Pipeline", "relation", "", "→ NOTION_INFLUENCER_DB_ID"],
    ],
  },
  {
    sheet: "Content Calendar",
    envVar: "NOTION_CONTENT_CALENDAR_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Status", "select/status", "raw idea | ideation | ready to record | editing | ready to post | posted", ""],
      ["Posting Haven", "date", "", "data de publicação"],
      ["Ad type", "select", "awareness | traffic | conversion", ""],
      ["Series", "select", "Haven About | Haven Benefits | Haven Community | Pilates Educational | Filler Studio | Filler Motivational | Filler Relatable | Filler Funny | Customer Highlight | Instructor Highlight | Funny & Relatable | Day to day | About us", ""],
      ["Caption", "text", "", ""],
      ["Post URL", "url", "", ""],
      ["Script", "text", "", ""],
      ["Clips", "text", "", ""],
      ["Description", "text", "", ""],
      ["Inspo video", "text", "", ""],
      ["Recording date", "date", "", ""],
      ["Type", "multi_select", "Haven | Ad", ""],
      ["Active ad", "checkbox", "", ""],
    ],
  },
  {
    sheet: "Parceiros",
    envVar: "NOTION_PARTNER_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Categoria", "select", "Corporate | Eventos | Parceria", ""],
      ["Status", "select", "A contactar | Contactado | A aguardar resposta | Em negociação | Fechado | Arquivado", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Último contacto", "date", "", ""],
      ["Próximo passo", "text", "", ""],
      ["Notas", "text", "", ""],
      ["Origem", "text", "", ""],
    ],
  },
  {
    sheet: "Influencers",
    envVar: "NOTION_INFLUENCER_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Instagram", "url", "", ""],
      ["Status", "select", "A identificar | A contactar | Contactado | Em conversa | Proposta enviada | Fechado | Arquivado", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Último contacto", "date", "", ""],
      ["Próximo passo", "text", "", ""],
      ["Canal de contacto", "select", "Instagram DM | Email | Outro", ""],
      ["Nicho", "text", "", ""],
      ["Seguidores (aprox.)", "select", "<5k | 5k - 20k | 20k - 100k | >100k", ""],
      ["Tipo de colaboração", "multi_select", "Visita ao estúdio | Post patrocinado | Parceria de longo prazo | Evento | Outro", ""],
      ["Origem", "text", "", ""],
    ],
  },
  {
    sheet: "Projetos",
    envVar: "NOTION_PROJECTS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Owner", "multi_select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Notas", "text", "", ""],
      ["Status", "status", "Not started | In progress | Done", ""],
      ["Área", "select", "Marketing | Operações | Parcerias | Influencers | Tech | Cliente | Financeiro | Outro", ""],
      ["Data de início", "date", "", ""],
      ["Deadline", "date", "", ""],
      ["Origem", "text", "", ""],
    ],
  },
  {
    sheet: "Eventos",
    envVar: "NOTION_EVENT_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Owner", "multi_select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Status", "status", "Ideia | A planear | Confirmado | Em preparação | Realizado | Cancelado", ""],
      ["Data", "date", "", ""],
      ["Notas", "text", "", ""],
      ["Próximo passo", "text", "", ""],
      ["Tipo", "select", "Aula | Evento | Co-branded | Workshop", ""],
      ["Origem", "text", "", ""],
    ],
  },
  {
    sheet: "Listas",
    envVar: "NOTION_LISTS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Item", "title", "", ""],
      ["Lista", "select", "", "cria automaticamente novos valores"],
      ["Fechada", "checkbox", "", ""],
      ["Adicionado por", "select", "Madalena | Mafalda | Beatriz", ""],
      ["Origem", "text", "", ""],
    ],
  },
  {
    sheet: "Founder Focus",
    envVar: "NOTION_FOUNDER_FOCUS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", "bot cria nome com base no foco operacional"],
      ["Founder", "select", "Madalena | Mafalda | Beatriz", ""],
      ["Semana", "formula", "", "read-only"],
      ["Foco operacional", "text", "", ""],
      ["Ativo", "checkbox", "", ""],
      ["Origem", "text", "", ""],
    ],
  },
];

const wb = XLSX.utils.book_new();

for (const db of dbs) {
  const ws = XLSX.utils.aoa_to_sheet(db.rows);

  ws["!cols"] = [
    { wch: 24 },  // Propriedade
    { wch: 14 },  // Tipo
    { wch: 80 },  // Valores
    { wch: 40 },  // Notas
  ];

  ws["F1"] = { t: "s", v: `env: ${db.envVar}` };

  XLSX.utils.book_append_sheet(wb, ws, db.sheet);
}

const outPath = path.join(__dirname, "..", "docs", "notion-db-config.xlsx");
XLSX.writeFile(wb, outPath);
console.log(`Criado: ${outPath}`);
