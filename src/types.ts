/**
 * Shared types for haven-ops bot.
 */

export type FounderName = "Madalena" | "Mafalda" | "Beatriz";
export type OwnerValue = FounderName | "Unassigned";

export type Area =
  | "Marketing"
  | "Operações"
  | "Parcerias"
  | "Influencers"
  | "Tech"
  | "Cliente"
  | "Financeiro"
  | "Outro";

export type Priority = "Alta" | "Média" | "Baixa";

export type Status = "A fazer" | "Em curso" | "Bloqueado" | "Feito" | "Cancelado";

export type EditableField = "status" | "owner" | "deadline" | "prioridade" | "area";


// ----- Phase 2 -----

export interface FounderFocusEntry {
  founder: FounderName;
  semana: string; // "Semana 18"
  focoOperacional: string;
}

export interface WeeklyPriority {
  taskId: string;
  title: string;
  owner: OwnerValue;
  area: Area;
  priority: Priority | null;
  deadline: string | null;
}

// ----- Phase 3 -----

export type PartnerStatus =
  | "A contactar"
  | "Contactado"
  | "A aguardar resposta"
  | "Em negociação"
  | "Fechado"
  | "Arquivado";

export type PartnerCategory = "Corporate" | "Eventos" | "Parceria";

export interface PartnerRow {
  id: string;
  nome: string;
  categoria: PartnerCategory | null;
  owner: OwnerValue;
  status: PartnerStatus | null;
  ultimoContacto: string | null;
  proximoPasso: string;
  notas: string;
}

export type InfluencerStatus =
  | "A identificar"
  | "A contactar"
  | "Contactado"
  | "Em conversa"
  | "Proposta enviada"
  | "Fechado"
  | "Arquivado";

export interface InfluencerRow {
  id: string;
  nome: string;
  instagram: string | null;
  owner: OwnerValue;
  status: InfluencerStatus | null;
  ultimoContacto: string | null;
  proximoPasso: string;
  notas: string;
}

export interface ReminderRow {
  id: string;
  texto: string;
  paraQuem: FounderName;
  quando: string; // ISO datetime
  origem: string; // original message
  enviado: boolean;
}

// ----- Phase 5 -----

export type ToDiscussUrgency =
  | "Próxima reunião"
  | "Decisão offline"
  | "Urgente";

export type ToDiscussState = "Pendente" | "Discutido" | "Arquivado";

export interface ToDiscussRow {
  id: string;
  tema: string;
  adicionadoPor: FounderName;
  urgencia: ToDiscussUrgency;
  area: Area;
  estado: ToDiscussState;
  data: string;
  resolucao: string;
  deadline?: string;
}

export interface DecisionRow {
  id: string;
  decisao: string;
  area: Area;
  tomadaPor: FounderName[];
  data: string | null;
  estado: "Pendente implementação" | "Implementada";
  notas: string;
}

export interface NewTaskExtraction {
  title: string;
  owner: OwnerValue;
  area: Area;
  why: string;
}

export interface EditExtraction {
  targetTaskId: string;
  targetTitle: string;
  field: EditableField;
  oldValue: string;
  newValue: string;
}

export interface OpenTask {
  id: string;
  title: string;
  owner: OwnerValue;
  area: Area;
  priority: Priority | null;
  deadline: string | null;
  status: Status;
}

export type PendingProposal =
  | {
      type: "new_task";
      botMessageId: number;
      extraction: NewTaskExtraction;
      originalMsg: string;
      originalSender: FounderName;
      createdAt: number;
    }
  | {
      type: "edit";
      botMessageId: number;
      extraction: EditExtraction;
      originalMsg: string;
      originalSender: FounderName;
      createdAt: number;
    };

export type FeedbackType = "confirmed" | "false_positive" | "correction";

export interface FeedbackEntry {
  type: FeedbackType;
  originalMsg: string;
  sender: FounderName;
  botExtraction: string; // JSON string
  userAction: string;
  userText?: string;
}

export interface ChatContext {
  text: string;
  sender: FounderName;
  recentMessages: { sender: FounderName; text: string }[];
  recentBotActions: RecentAction[];
  openTasks: OpenTask[];
}

// ----- Multi-intent (Phase 1 redesign, 2026-05-01) -----

export type IntentType =
  | "NEW_TASK"
  | "EDIT_TASK"
  | "REMINDER"
  | "LOG"
  | "DECISION"
  | "LAUNCH_INTENT"
  | "EDIT_PENDING"
  | "SET_DEPENDENCY"
  | "TO_DISCUSS"
  | "CREATE_ENTITY";

export interface NewTaskIntent {
  type: "NEW_TASK";
  title: string;
  owner: OwnerValue;
  area: Area;
  why: string;
  priority: Priority;
  entityRef?: EntityRef;
}

export interface EditTaskIntent {
  type: "EDIT_TASK";
}

export interface ReminderIntent {
  type: "REMINDER";
  when: string;
  text: string;
  for: FounderName | "all";
}

export interface LogIntent {
  type: "LOG";
  text: string;
  tags: string[];
}

export interface DecisionIntent {
  type: "DECISION";
  text: string;
  context: string;
}

export type LaunchKind = "programa-novo" | "parceria" | "evento" | "influencer";

export interface LaunchIntentIntent {
  type: "LAUNCH_INTENT";
  what: string;
  when: string;
  kind: LaunchKind;
}

export type EditPendingField =
  | "owner"
  | "area"
  | "priority"
  | "when"
  | "title"
  | "tags"
  | "cancel";

export interface EditPendingIntent {
  type: "EDIT_PENDING";
  ref: string;
  field: EditPendingField;
  value: string | null;
}

export interface SetDependencyIntent {
  type: "SET_DEPENDENCY";
  blocked: string;
  blockedOwner: OwnerValue;
  prerequisite: string;
  prerequisiteOwner: OwnerValue;
}

export interface ToDiscussIntent {
  type: "TO_DISCUSS";
  tema: string;
  urgencia: ToDiscussUrgency;
  area: Area;
}

export type EntityKind = "projeto" | "evento" | "parceria" | "influencer";

export interface EntityRef {
  kind: EntityKind;
  nome: string;
}

export interface CreateEntityIntent {
  type: "CREATE_ENTITY";
  kind: EntityKind;
  nome: string;
  owner: OwnerValue;
}

export type Intent =
  | NewTaskIntent
  | EditTaskIntent
  | ReminderIntent
  | LogIntent
  | DecisionIntent
  | LaunchIntentIntent
  | EditPendingIntent
  | SetDependencyIntent
  | ToDiscussIntent
  | CreateEntityIntent;

export interface RecentAction {
  id: string;
  type: IntentType;
  status: "pending" | "committed" | "cancelled";
  summary: string;
  createdAt: number;
  notionPageId: string | null;
  botMessageId: number | null;
}
