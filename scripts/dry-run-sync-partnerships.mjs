/**
 * Read-only rehearsal for src/crons/sync-partnerships.ts, run once before
 * that cron is ever deployed (and again any time partnership-email-intent.md
 * changes). Runs the exact same known-contact/classify/dedup pipeline
 * against real Outlook mailboxes + real Notion + real Anthropic, but never
 * calls notion.createPartner/createInfluencer/updatePartnerFields/
 * updateInfluencerFields, never forwards/archives a message, and never
 * touches data/partnerships-sync-state.json — purely diagnostic. Same
 * relationship scripts/dry-run-instagram-leads.mjs has to
 * leads-instagram-scan.ts; mirrors that script's structure.
 *
 * Prints every message that WOULD update a known contact, create a new
 * Partner/Influencer Pipeline row, or get skipped as a likely duplicate —
 * so a founder can spot-check classifier accuracy (known partner, known
 * influencer, known noise/vendor case) before the live cron runs
 * unattended, and confirm the known-contact matching isn't misfiring.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/dry-run-sync-partnerships.mjs [--since=YYYY-MM-DD] [--mailbox=addr ...]
 *
 * Omitting --since scans full mailbox history (same as the live cron's
 * first run) — for a quick review, pass --since to bound it, e.g.
 * --since=2026-08-01. --mailbox may be repeated; defaults to "me" plus
 * every address in OUTLOOK_MAILBOXES, same as the live cron.
 */

import { enrichInfluencerFromTranscript, enrichPartnerFromTranscript, classifyPartnershipEmailIntent } from "../dist/lib/lead-classifier.js";
import * as notion from "../dist/notion.js";
import * as outlook from "../dist/lib/outlook.js";
import { buildContactLookups, domainOf, guessExternalParty, matchKnownContact } from "../dist/lib/outlook-contact-matching.js";

function parseArgs(argv) {
  const out = { since: undefined, mailboxes: [] };
  for (const arg of argv) {
    if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
    else if (arg.startsWith("--mailbox=")) out.mailboxes.push(arg.slice("--mailbox=".length));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await notion.initialize();

  const configuredMailboxes = (process.env.OUTLOOK_MAILBOXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mailboxes = args.mailboxes.length > 0 ? args.mailboxes : ["me", ...configuredMailboxes];

  const myEmail = await outlook.getMyEmail();
  const ownDomains = new Set([domainOf(myEmail), ...configuredMailboxes.map(domainOf)].filter(Boolean));

  const [existingPartners, existingInfluencers] = await Promise.all([
    notion.getAllPartnerContacts(),
    notion.getAllInfluencerContacts(),
  ]);
  const partnerLookups = buildContactLookups(existingPartners, ownDomains);
  const influencerLookups = buildContactLookups(existingInfluencers, ownDomains);
  console.log(
    `Known contacts: ${partnerLookups.emailToContact.size} partner email(s)/${partnerLookups.domainToContact.size} domain(s), ` +
      `${influencerLookups.emailToContact.size} influencer email(s)/${influencerLookups.domainToContact.size} domain(s).`,
  );

  const sinceISO = args.since ? new Date(`${args.since}T00:00:00.000Z`).toISOString() : undefined;
  console.log(`Scanning ${mailboxes.length} mailbox(es), since=${sinceISO ?? "(full history)"}`);
  console.log(`Mailboxes: ${mailboxes.join(", ")}\n`);

  let scanned = 0;
  let updatedKnown = 0;
  let createdPartners = 0;
  let createdInfluencers = 0;
  let skippedDuplicates = 0;
  let skippedNenhum = 0;
  let skippedNoExternalParty = 0;

  for (const mailbox of mailboxes) {
    let messages;
    try {
      messages = await outlook.searchMailboxMessages(mailbox, { sinceISO });
    } catch (err) {
      console.error(`  ✗ ${mailbox}: ${err.message}`);
      continue;
    }
    console.log(`── ${mailbox}: ${messages.length} message(s) ──`);
    scanned += messages.length;

    for (const msg of messages) {
      const text = `${msg.subject}\n${msg.body}`;

      const partnerMatch = matchKnownContact(msg.from, msg.to, ownDomains, partnerLookups);
      const influencerMatch = matchKnownContact(msg.from, msg.to, ownDomains, influencerLookups);

      if (partnerMatch?.matchBasis === "exact_email" || influencerMatch?.matchBasis === "exact_email") {
        updatedKnown++;
        const isPartner = partnerMatch?.matchBasis === "exact_email";
        const contact = isPartner ? partnerMatch.contact : influencerMatch.contact;
        console.log(`[known ${isPartner ? "partner" : "influencer"}] "${msg.subject}" — de ${msg.from.name} <${msg.from.email}>`);
        console.log(`  -> seria atualizado: ${contact.name} (${contact.id}) — Último contacto = ${msg.receivedDateTime.slice(0, 10)}`);
        continue;
      }

      const classification = await classifyPartnershipEmailIntent(text);

      if (classification === "nenhum") {
        skippedNenhum++;
        continue;
      }

      const externalParty = guessExternalParty(msg.from, msg.to, ownDomains);
      if (!externalParty) {
        skippedNoExternalParty++;
        console.log(`[sem destinatário externo — ${classification}] "${msg.subject}" — de ${msg.from.name} <${msg.from.email}> (mensagem interna, sem destinatário fora do domínio) — NÃO criaria\n`);
        continue;
      }
      const domainHintContact = classification === "parceiro" ? partnerMatch?.contact : influencerMatch?.contact;
      const dbKey = classification === "parceiro" ? "partners" : "influencers";
      const nameMatch = domainHintContact
        ? { id: domainHintContact.id, title: domainHintContact.name }
        : await notion.findPageInDb(dbKey, externalParty.name);

      if (nameMatch) {
        skippedDuplicates++;
        console.log(`[duplicado — ${classification}] "${msg.subject}" — de ${msg.from.name} <${msg.from.email}>`);
        console.log(`  -> corresponderia a "${nameMatch.title}" (${nameMatch.id}${domainHintContact ? ", via domínio" : ""}) — NÃO criaria\n`);
        continue;
      }

      if (classification === "parceiro") {
        createdPartners++;
        console.log(`[parceiro] "${msg.subject}" — de ${externalParty.name} <${externalParty.email || "sem email"}>`);
        console.log('  -> seria criado em Partner Pipeline (Categoria = "Parceria", Status = "A contactar")');
        const enrichment = await enrichPartnerFromTranscript(text);
        console.log(`  Sobre o parceiro: ${enrichment?.sobre ?? "(NADA)"}`);
        console.log(`  Deal e proposta: ${enrichment?.deal ?? "(NADA)"}`);
        console.log(`  Log: ${enrichment?.log ?? "(falhou)"}\n`);
        continue;
      }

      // classification === "influencer"
      createdInfluencers++;
      console.log(`[influencer] "${msg.subject}" — de ${externalParty.name} <${externalParty.email || "sem email"}>`);
      console.log('  -> seria criado em Influencer Pipeline (Canal de contacto = "Email")');
      const enrichment = await enrichInfluencerFromTranscript(text);
      console.log(`  Perfil e stats — Sobre: ${enrichment?.sobre ?? "(NADA)"}`);
      console.log(`  Relação e histórico: ${enrichment?.log ?? "(falhou)"}`);
      console.log(`  Nicho: ${enrichment?.nicho ?? "(NADA)"}`);
      console.log(`  Tipo de colaboração: ${enrichment?.tipoColaboracao?.join(", ") || "(NADA)"}\n`);
    }
  }

  console.log(
    `\n${scanned} mensagens · ${updatedKnown} atualizariam um contacto conhecido · ${createdPartners} candidatos a parceiro · ` +
      `${createdInfluencers} candidatos a influencer · ${skippedDuplicates} duplicados (não criados) · ${skippedNoExternalParty} sem destinatário externo (mensagem interna) · ${skippedNenhum} nenhuma das categorias.`,
  );
  console.log(
    "\nEste script é só de leitura — não escreveu no Notion, não reencaminhou/arquivou nenhum email, não tocou no checkpoint. Revê os candidatos acima, especialmente qualquer 'nenhuma das categorias' que devia ter sido apanhado, antes de confiar no próximo run real do cron.",
  );
}

main().catch((err) => {
  console.error("dry-run failed:", err);
  process.exit(1);
});
