/**
 * Read-only rehearsal for src/crons/leads-instagram-scan.ts, run once
 * before that cron is ever deployed. Runs the exact same fetch/exclude/
 * classify/match pipeline against real Studio Supabase + real Anthropic,
 * but never calls notion.createLead and never touches the checkpoint file
 * — purely diagnostic. Prints every contact that WOULD become a lead, so
 * the founder can review before the standing cron runs for real:
 *   - confirm the exclusion list catches everyone it should (staff,
 *     founders, known peer/business contacts) — anyone that shouldn't be
 *     here but is, hand their exact display name/username back to be
 *     added to EXCLUDED_INSTAGRAM_NAMES in src/lib/instagram-inbox.ts
 *   - spot-check a few borderline classifications
 *   - confirm extracted emails/phones look right
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/dry-run-instagram-leads.mjs
 */

import {
  buildTranscript,
  extractVolunteeredEmail,
  extractVolunteeredPhone,
  fetchInstagramContactsWithMessages,
  isExcludedInstagramContact,
} from "../dist/lib/instagram-inbox.js";
import { checkExistingCustomer, fetchAllCustomerNames } from "../dist/lib/leads.js";
import { isGenuineInformationRequestDM } from "../dist/lib/lead-classifier.js";

async function main() {
  const [contacts, customers] = await Promise.all([
    fetchInstagramContactsWithMessages(),
    fetchAllCustomerNames(),
  ]);
  console.log(`Fetched ${contacts.length} Instagram contacts, ${customers.length} CRM customers.\n`);

  let excluded = 0;
  let noText = 0;
  let notLead = 0;
  let candidates = 0;

  for (const contact of contacts) {
    if (isExcludedInstagramContact(contact)) {
      excluded++;
      continue;
    }

    const transcript = buildTranscript(contact.messages);
    if (!transcript) {
      noText++;
      continue;
    }

    const isLead = await isGenuineInformationRequestDM(transcript);
    if (!isLead) {
      notLead++;
      continue;
    }

    const email = extractVolunteeredEmail(contact.messages);
    const phone = extractVolunteeredPhone(contact.messages);
    const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
    const check = await checkExistingCustomer(email, name, customers);
    const handle = contact.username ? `@${contact.username}` : contact.platformUserId;

    candidates++;
    console.log(`[candidato] ${name} (${handle}) — id=${contact.id}, ${contact.messageCount} mensagens`);
    console.log(`  email: ${email ?? "(nenhum)"} · telefone: ${phone ?? "(nenhum)"}`);
    if (check.isExistingCustomer) {
      console.log("  -> JÁ CLIENTE (compra confirmada) — NÃO seria criado lead");
    } else if (check.fuzzyMatch) {
      console.log(
        `  -> match incerto no CRM: "${check.fuzzyMatch.name}" (score ${check.fuzzyMatch.score.toFixed(2)}) — seria criado, Verificação = "Match incerto — rever manualmente"`,
      );
    } else {
      console.log('  -> sem correspondência no CRM — seria criado, Verificação = "Sem correspondência"');
    }
    console.log();
  }

  console.log(
    `${contacts.length} contactos Instagram · ${excluded} excluídos · ${noText} sem texto · ${notLead} não são pedidos de informação · ${candidates} candidatos a lead.`,
  );
  console.log(
    "\nEste script é só de leitura — não escreveu no Notion nem no checkpoint. Revê os candidatos acima antes de confiar no próximo run real do cron.",
  );
}

main().catch((err) => {
  console.error("dry-run failed:", err);
  process.exit(1);
});
