import fs from "node:fs";
import path from "node:path";
import { isSuspiciousBatch } from "../lib/circuit-breaker.js";
import { CLIENTS_LABEL, STATUS_LABELS, UPDATE_FIELDS, desiredContacts, personForCreate, personForUpdate, planSync, toExistingContact, } from "../lib/contacts-sync.js";
import { getTelegramId } from "../lib/founders.js";
import * as googleContacts from "../lib/google-contacts.js";
import { log } from "../lib/log.js";
import { fetchContactSyncRows } from "../lib/pulse-views.js";
import { sendDM, sendGroupMessage } from "../lib/telegram.js";
import { formatLisbonDateTime } from "../lib/tz.js";
/**
 * Keeps the studio's Google Contacts in step with the studio's clients
 * (Mafalda, 2026-10-10), so a number that calls or writes on WhatsApp shows who
 * it is and where they stand.
 *
 * Source: everyone in v_pulse_member_identity with a phone, one contact per
 * phone number. Every contact carries the label "Haven clients" plus exactly ONE
 * status label, which is the `status` column of va.v_pulse_contact_status
 * (scripts/studio-db-contact-status-2026-10-10.sql) — the rule is in that view,
 * not here. The member_id is stored inside the contact (clientData
 * `haven_member_id`), and each run diffs the label against the view: new people
 * are created, a changed name / number / status is updated, and a contact no
 * longer in the view is removed. The first run adopts the 574 contacts imported
 * by CSV on 2026-10-10, matching them by phone number.
 *
 * Only contacts in the "Haven clients" label are ever read or written. On a
 * contact it owns, the sync writes the name, the phone, the member_id and its
 * own labels; any other label and any other field stay as they are.
 *
 * Nothing is written when the run looks wrong: an empty view, a status the view
 * does not name, an empty label on the first run (the wrong Google account, or
 * the import is not there), or a run that would create or remove an implausible
 * share of the list. GOOGLE_CONTACTS_FORCE=true lets one such run through;
 * GOOGLE_CONTACTS_DRY_RUN=true writes nothing and reports what it would do.
 *
 * Health: every failed run — an expired or revoked Google login included — is a
 * Telegram message to Madalena (the group if her ID is not set), repeated each
 * day until a run succeeds, then one "back to normal". Silent on success. State:
 * DATA_DIR/google-contacts-sync-state.json. Before `/authcontacts` has ever been
 * done the cron only logs: the feature is not switched on yet.
 *
 * Schedule: 06:30 Europe/Lisbon every day. Registered in src/server.ts.
 */
const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "google-contacts-sync-state.json");
// A daily diff is a handful of people. More than these shares in one run is far
// more likely a wrong account, a phone-format change or a view regression.
const CREATE_BREAKER = { share: 0.25, minRows: 25 };
const REMOVE_BREAKER = { share: 0.1, minRows: 10 };
const EMPTY_STATE = {
    lastSuccessAt: null,
    lastRunAt: null,
    lastError: null,
    consecutiveFailures: 0,
    lastCounts: null,
};
function loadState() {
    try {
        return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
    }
    catch {
        return { ...EMPTY_STATE };
    }
}
function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    }
    catch (err) {
        log.error("cron.google_contacts_sync.save_state_failed", { message: errMsg(err) });
    }
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
/** A run stopped on purpose before any write; `message` is the pt-PT reason for the alert. */
export class SyncAbort extends Error {
}
function isOn(envVar) {
    return process.env[envVar] === "true";
}
async function notify(text) {
    try {
        const madalena = getTelegramId("Madalena");
        if (madalena !== null)
            await sendDM(madalena, text);
        else
            await sendGroupMessage(text);
    }
    catch (err) {
        log.error("cron.google_contacts_sync.notify_failed", { message: errMsg(err) });
    }
}
function countsLine(c) {
    return `${c.created} criados, ${c.updated} atualizados, ${c.removed} removidos, ${c.unchanged} sem alterações`;
}
/** The checks that stop a run before it writes. Exported for the tests. */
export function assertPlausible(plan, sizes, opts) {
    if (opts.force)
        return;
    if (opts.firstRun && sizes.inLabel === 0) {
        throw new SyncAbort(`a etiqueta "${CLIENTS_LABEL}" não existe ou está vazia nesta conta Google. Devia ter os contactos importados a 10/10 — confirma que o /authcontacts foi feito com a conta ${googleContacts.STUDIO_ACCOUNT}. Para criar tudo de raiz, corre uma vez com GOOGLE_CONTACTS_FORCE=true.`);
    }
    if (sizes.inLabel > 0 && isSuspiciousBatch(plan.create.length, sizes.inView, CREATE_BREAKER)) {
        throw new SyncAbort(`ia criar ${plan.create.length} contactos novos de uma vez (${sizes.inView} pessoas na vista, ${sizes.inLabel} na etiqueta). Parece engano — vê com GOOGLE_CONTACTS_DRY_RUN=true; se estiver certo, corre uma vez com GOOGLE_CONTACTS_FORCE=true.`);
    }
    if (isSuspiciousBatch(plan.remove.length, sizes.inLabel, REMOVE_BREAKER)) {
        throw new SyncAbort(`ia remover ${plan.remove.length} dos ${sizes.inLabel} contactos da etiqueta "${CLIENTS_LABEL}". Parece engano — vê com GOOGLE_CONTACTS_DRY_RUN=true; se estiver certo, corre uma vez com GOOGLE_CONTACTS_FORCE=true.`);
    }
}
async function sync(state, dryRun) {
    const rows = await fetchContactSyncRows();
    const { contacts: desired, skipped } = desiredContacts(rows);
    if (skipped.unknownStatus.length > 0) {
        const values = [...new Set(skipped.unknownStatus)].join(", ");
        throw new SyncAbort(`a vista v_pulse_contact_status deu um estado que o bot não conhece (${values}) a ${skipped.unknownStatus.length} pessoa(s). Falta acrescentá-lo à vista e à lista de etiquetas.`);
    }
    if (desired.length === 0) {
        throw new SyncAbort("a vista dos clientes veio vazia (0 pessoas com telefone).");
    }
    const groups = await googleContacts.listUserGroups();
    const groupByName = new Map(groups.map((g) => [g.name, g.resourceName]));
    const statusByGroup = new Map();
    for (const status of STATUS_LABELS) {
        const resourceName = groupByName.get(status);
        if (resourceName)
            statusByGroup.set(resourceName, status);
    }
    const clientsGroup = groupByName.get(CLIENTS_LABEL);
    const existing = clientsGroup
        ? (await googleContacts.listGroupContacts(clientsGroup)).map((p) => toExistingContact(p, statusByGroup))
        : [];
    const plan = planSync(desired, existing);
    const counts = {
        inView: desired.length,
        inLabel: existing.length,
        created: plan.create.length,
        updated: plan.update.length,
        removed: plan.remove.length,
        unchanged: plan.unchanged,
        matchedByPhone: plan.matchedByPhone,
    };
    log.info("cron.google_contacts_sync.plan", { ...counts, skipped: { ...skipped, unknownStatus: 0 }, dryRun });
    assertPlausible(plan, { inView: desired.length, inLabel: existing.length }, { firstRun: state.lastSuccessAt === null, force: isOn("GOOGLE_CONTACTS_FORCE") });
    if (dryRun)
        return counts;
    // Labels first: a contact can only be put in a label that exists.
    for (const name of [CLIENTS_LABEL, ...STATUS_LABELS]) {
        if (!groupByName.has(name))
            groupByName.set(name, (await googleContacts.createGroup(name)).resourceName);
    }
    const labelGroups = {
        clients: groupByName.get(CLIENTS_LABEL),
        status: Object.fromEntries(STATUS_LABELS.map((s) => [s, groupByName.get(s)])),
    };
    await googleContacts.createContacts(plan.create.map((d) => personForCreate(d, labelGroups)));
    await googleContacts.updateContacts(plan.update.map((u) => personForUpdate(u.existing, u.desired, labelGroups)), UPDATE_FIELDS);
    await googleContacts.deleteContacts(plan.remove.map((e) => e.resourceName));
    return counts;
}
export async function run(now = new Date()) {
    const state = loadState();
    const dryRun = isOn("GOOGLE_CONTACTS_DRY_RUN");
    if (!googleContacts.isAuthenticated() && state.lastSuccessAt === null) {
        // Never switched on: /authcontacts has not been done. Not a failure.
        log.warn("cron.google_contacts_sync.not_authenticated");
        return;
    }
    try {
        const counts = await sync(state, dryRun);
        log.info("cron.google_contacts_sync.done", { ...counts, dryRun });
        if (dryRun) {
            await notify(`Contactos Google (simulação, nada foi escrito): ${counts.inView} pessoas na vista, ${counts.inLabel} na etiqueta "${CLIENTS_LABEL}" (${counts.matchedByPhone} reconhecidas pelo telefone). Faria: ${countsLine(counts)}.`);
            return;
        }
        if (state.lastSuccessAt === null) {
            await notify(`✅ Contactos Google ligados: ${counts.inView} clientes na etiqueta "${CLIENTS_LABEL}", cada um com a sua etiqueta de estado. Primeira sincronização: ${counts.matchedByPhone} reconhecidos pelo telefone, ${countsLine(counts)}.`);
        }
        else if (state.consecutiveFailures > 0) {
            await notify(`✅ Contactos Google: a sincronização voltou a funcionar (${countsLine(counts)}).`);
        }
        saveState({
            lastSuccessAt: now.toISOString(),
            lastRunAt: now.toISOString(),
            lastError: null,
            consecutiveFailures: 0,
            lastCounts: counts,
        });
    }
    catch (err) {
        const authError = googleContacts.isAuthError(err);
        const message = errMsg(err);
        log.error("cron.google_contacts_sync.failed", { message, authError, aborted: err instanceof SyncAbort });
        saveState({
            ...state,
            lastRunAt: now.toISOString(),
            lastError: message,
            consecutiveFailures: state.consecutiveFailures + 1,
        });
        const reason = authError
            ? "O acesso à conta Google do estúdio expirou ou foi revogado. Faz /authcontacts em privado para voltar a ligar."
            : err instanceof SyncAbort
                ? `Parei antes de escrever: ${message}`
                : `Erro: ${message}`;
        const last = state.lastSuccessAt ? formatLisbonDateTime(new Date(state.lastSuccessAt)) : "nunca";
        await notify(`⚠️ Contactos Google: a sincronização dos clientes falhou.\n\n${reason}\n\nÚltima sincronização com sucesso: ${last}.`);
    }
}
