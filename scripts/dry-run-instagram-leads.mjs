/**
 * Read-only rehearsal for src/crons/leads-instagram-scan.ts, run once
 * before that cron is ever deployed. Runs the exact same fetch/exclude/
 * classify/match pipeline against real Studio Supabase + real Anthropic,
 * but never calls notion.createLead/createPartner and never touches the
 * checkpoint file — purely diagnostic. Prints every contact that WOULD
 * become a lead or a potential-partner candidate, so the founder can
 * review before the standing cron runs for real:
 *   - confirm the exclusion list catches everyone it should (staff,
 *     founders, known peer/business contacts) — anyone that shouldn't be
 *     here but is, hand their exact display name/username back to be
 *     added to EXCLUDED_INSTAGRAM_NAMES in src/lib/instagram-inbox.ts
 *   - spot-check a few borderline classifications, including
 *     cliente-vs-parceiro-vs-influencer calls
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
  hasInboundMessage,
  isExcludedInstagramContact,
} from "../dist/lib/instagram-inbox.js";
import { checkExistingCustomer, fetchAllCustomerNames, fetchAllVisitHistory, findBestNameMatch, findVisitHistory } from "../dist/lib/leads.js";
import { classifyInstagramDM, enrichInfluencerFromTranscript, enrichPartnerFromTranscript } from "../dist/lib/lead-classifier.js";

function formatDatePt(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function formatKenkoLine(volunteeredEmail, name, customers, activity) {
  if (volunteeredEmail) {
    const history = findVisitHistory(volunteeredEmail, activity);
    if (history && history.visitCount > 0 && history.firstVisit && history.lastVisit) {
      return `Kenko: já visitou o estúdio — ${history.visitCount} visitas, primeira em ${formatDatePt(history.firstVisit)}, última em ${formatDatePt(history.lastVisit)}.`;
    }
    return "Kenko: sem histórico de visitas para este email.";
  }
  const fuzzy = findBestNameMatch(name, customers);
  if (fuzzy) return `Kenko: possível correspondência (nome semelhante a ${fuzzy.name}) — por confirmar manualmente.`;
  return "Kenko: sem correspondência.";
}

async function main() {
  const [contacts, customers, activity] = await Promise.all([
    fetchInstagramContactsWithMessages(),
    fetchAllCustomerNames(),
    fetchAllVisitHistory(),
  ]);
  console.log(`Fetched ${contacts.length} Instagram contacts, ${customers.length} CRM customers.\n`);

  let excluded = 0;
  let alreadyContacted = 0;
  let noText = 0;
  let nenhum = 0;
  let clienteCandidates = 0;
  let parceiroCandidates = 0;
  let influencerCandidates = 0;

  for (const contact of contacts) {
    if (isExcludedInstagramContact(contact)) {
      excluded++;
      continue;
    }

    const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
    const handle = contact.username ? `@${contact.username}` : "sem @ (só nome no Instagram)";

    // The studio's own cold outreach (e.g. an influencer/brand campaign)
    // that never got a reply — must be checked before classifying, since
    // an out-only transcript still contains our own "parceria" language
    // and would otherwise fool the classifier into a false "parceiro".
    // No classification needed: it's still logged, just as an
    // already-contacted partner, not a judgment call.
    if (!hasInboundMessage(contact.messages)) {
      if (!buildTranscript(contact.messages)) {
        noText++;
        continue;
      }
      alreadyContacted++;
      console.log(`[já contactado] ${name} (${handle}) — id=${contact.id}, ${contact.messageCount} mensagens`);
      console.log('  -> seria criado em Partner Pipeline (Categoria = "Parceria", Status = "Contactado")\n');
      continue;
    }

    const transcript = buildTranscript(contact.messages);
    if (!transcript) {
      noText++;
      continue;
    }

    const classification = await classifyInstagramDM(transcript);

    if (classification === "nenhum") {
      nenhum++;
      continue;
    }

    if (classification === "parceiro") {
      parceiroCandidates++;
      console.log(`[parceiro] ${name} (${handle}) — id=${contact.id}, ${contact.messageCount} mensagens`);
      console.log('  -> seria criado em Partner Pipeline (Categoria = "Parceria", Status = "A contactar")');
      const enrichment = await enrichPartnerFromTranscript(transcript);
      console.log(`  Sobre o parceiro: ${enrichment?.sobre ?? "(NADA)"}`);
      console.log(`  Deal e proposta: ${enrichment?.deal ?? "(NADA)"}`);
      console.log(`  Log: ${enrichment?.log ?? "(falhou)"}\n`);
      continue;
    }

    if (classification === "influencer") {
      influencerCandidates++;
      console.log(`[influencer] ${name} (${handle}) — id=${contact.id}, ${contact.messageCount} mensagens`);
      console.log('  -> seria criado em Influencer Pipeline (Canal de contacto = "Instagram DM")');
      const enrichment = await enrichInfluencerFromTranscript(transcript);
      const volunteeredEmail = extractVolunteeredEmail(contact.messages);
      console.log(`  Perfil e stats — Sobre: ${enrichment?.sobre ?? "(NADA)"}`);
      console.log(`  Perfil e stats — ${formatKenkoLine(volunteeredEmail, name, customers, activity)}`);
      console.log(`  Relação e histórico: ${enrichment?.log ?? "(falhou)"}\n`);
      continue;
    }

    // classification === "cliente"
    const email = extractVolunteeredEmail(contact.messages);
    const phone = extractVolunteeredPhone(contact.messages);
    const check = await checkExistingCustomer(email, name, customers);

    clienteCandidates++;
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
    `${contacts.length} contactos Instagram · ${excluded} excluídos · ${alreadyContacted} já contactados por nós (Partner Pipeline, Status="Contactado") · ${noText} sem texto · ${nenhum} nenhuma das categorias · ${clienteCandidates} candidatos a lead · ${parceiroCandidates} candidatos a parceiro · ${influencerCandidates} candidatos a influencer.`,
  );
  console.log(
    "\nEste script é só de leitura — não escreveu no Notion nem no checkpoint. Revê os candidatos acima antes de confiar no próximo run real do cron.",
  );
}

main().catch((err) => {
  console.error("dry-run failed:", err);
  process.exit(1);
});
