import XLSX from "xlsx";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      ["Deadline", "date", "", ""],
      ["Notas", "rich_text", "", ""],
      ["Prioridade semanal", "checkbox", "", ""],
      ["Semana", "formula", "", "read-only"],
      ["Depende de", "relation", "", "→ própria DB"],
      ["Projects", "relation", "", "→ NOTION_PROJECTS_DB_ID"],
      ["Events Pipeline", "relation", "", "→ NOTION_EVENT_DB_ID"],
      ["Partner Pipeline", "relation", "", "→ NOTION_PARTNER_DB_ID"],
      ["Influencer Pipeline", "relation", "", "→ NOTION_INFLUENCER_DB_ID"],
    ],
  },
  {
    sheet: "Lembretes",
    envVar: "NOTION_REMINDERS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Texto", "title", "", ""],
      ["Para quem", "select", "Madalena | Mafalda | Beatriz", ""],
      ["Quando", "date", "", "inclui hora"],
      ["Origem", "rich_text", "", ""],
      ["Enviado", "checkbox", "", ""],
    ],
  },
  {
    sheet: "Para Discutir",
    envVar: "NOTION_TO_DISCUSS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Adicionado por", "select", "Madalena | Mafalda | Beatriz", ""],
      ["Urgência", "select", "Próxima reunião | Decisão offline | Urgente", ""],
      ["Área", "select", "Marketing | Operações | Parcerias | Influencers | Tech | Cliente | Financeiro | Outro", ""],
      ["Estado", "select", "Pendente | Discutido | Arquivado", ""],
      ["Resolução", "rich_text", "", ""],
      ["Deadline", "date", "", "opcional"],
      ["Data", "date", "", ""],
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
      ["Data", "date", "", ""],
      ["Notas", "rich_text", "", ""],
    ],
  },
  {
    sheet: "Content Calendar",
    envVar: "NOTION_CONTENT_CALENDAR_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", "ou Título ou Title"],
      ["Status", "select/status", "raw idea | ideation | ready to record | editing | ready to post | posted", ""],
      ["Data publicação", "date", "", "ou Publish date ou Data"],
      ["Posting Haven", "date", "", ""],
      ["Ad type", "select", "awareness | traffic | conversion", ""],
    ],
  },
  {
    sheet: "Parceiros",
    envVar: "NOTION_PARTNER_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Categoria", "select", "", ""],
      ["Status", "select", "", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Último contacto", "date", "", ""],
      ["Próximo passo", "rich_text", "", ""],
    ],
  },
  {
    sheet: "Influencers",
    envVar: "NOTION_INFLUENCER_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Instagram", "url", "", ""],
      ["Status", "select", "", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Último contacto", "date", "", ""],
      ["Próximo passo", "rich_text", "", ""],
    ],
  },
  {
    sheet: "Projetos",
    envVar: "NOTION_PROJECTS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
    ],
  },
  {
    sheet: "Eventos",
    envVar: "NOTION_EVENT_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Name", "title", "", ""],
      ["Owner", "select", "Madalena | Mafalda | Beatriz | Unassigned", ""],
      ["Status", "select", "", ""],
    ],
  },
  {
    sheet: "Listas",
    envVar: "NOTION_LISTS_DB_ID",
    rows: [
      ["Propriedade", "Tipo", "Valores possíveis", "Notas"],
      ["Item", "title", "", ""],
      ["Lista", "select", "", "cria automaticamente novos valores"],
      ["Feito", "checkbox", "", ""],
      ["Adicionado por", "select", "Madalena | Mafalda | Beatriz", ""],
    ],
  },
];

const wb = XLSX.utils.book_new();

for (const db of dbs) {
  const ws = XLSX.utils.aoa_to_sheet(db.rows);

  // Column widths
  ws["!cols"] = [
    { wch: 24 },  // Propriedade
    { wch: 14 },  // Tipo
    { wch: 60 },  // Valores
    { wch: 28 },  // Notas
  ];

  // Add env var in cell F1 as reference
  ws["F1"] = { t: "s", v: `env: ${db.envVar}` };

  XLSX.utils.book_append_sheet(wb, ws, db.sheet);
}

const outPath = path.join(__dirname, "..", "docs", "notion-db-config.xlsx");
XLSX.writeFile(wb, outPath);
console.log(`Criado: ${outPath}`);
