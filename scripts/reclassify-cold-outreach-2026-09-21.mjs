/**
 * One-off cleanup: reclassifies the cold-outreach ("já contactado", no
 * reply) contacts already created in Partner Pipeline BEFORE
 * classifyOutreachIntent shipped (2026-09-21) — every one of them went
 * there unconditionally regardless of what the studio's own message
 * actually said, which silently misrouted the team's own
 * influencer-outreach template (e.g. Márcia Soares — "achamos que fazes
 * match com a nossa vibe, vem experimentar uma aula") alongside real
 * partner outreach (e.g. Wanderlust's goodie-bag ask).
 *
 * Reads the checkpoint (data/instagram-leads-sync-state.json), finds
 * every entry classified "parceiro" with a notionPageId, re-fetches the
 * real transcript to confirm it's actually cold-outreach (no inbound
 * reply — the checkpoint alone can't tell a cold-outreach "parceiro" from
 * a real inbound one, both use the same string), and re-runs
 * classifyOutreachIntent on the studio's own message. Where the result is
 * "influencer": creates the Influencer Pipeline page, archives the old
 * Partner Pipeline page (never deleted), and updates the checkpoint to
 * point at the new page. Where it's still "parceiro": leaves it alone —
 * already correctly placed.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/reclassify-cold-outreach-2026-09-21.mjs [--apply]
 */

import fs from "node:fs";

import { buildTranscript, fetchInstagramContactsWithMessages, hasInboundMessage } from "../dist/lib/instagram-inbox.js";
import { classifyOutreachIntent } from "../dist/lib/lead-classifier.js";
import { archivePage, createInfluencer, getAllInfluencerContacts } from "../dist/notion.js";

const STATE_PATH = process.env.STATE_PATH ?? "instagram-leads-sync-state.json";

async function main() {
  const apply = process.argv.includes("--apply");
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const partnerEntries = Object.entries(state).filter(
    ([, entry]) => entry.classification === "parceiro" && entry.notionPageId,
  );
  console.log(`${partnerEntries.length} parceiro-classified checkpoint entries to check.\n`);

  const [contacts, existingInfluencers] = await Promise.all([
    fetchInstagramContactsWithMessages(),
    getAllInfluencerContacts(),
  ]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  let moved = 0;
  let confirmedPartner = 0;
  let skippedNotColdOutreach = 0;
  let skippedNoContact = 0;
  let failed = 0;

  for (const [contactId, entry] of partnerEntries) {
    const contact = contactsById.get(contactId);
    if (!contact) {
      skippedNoContact++;
      continue;
    }
    if (hasInboundMessage(contact.messages)) {
      // A real inbound "parceiro" classification, not cold-outreach —
      // not in scope for this cleanup.
      skippedNotColdOutreach++;
      continue;
    }
    const outreachText = buildTranscript(contact.messages);
    if (!outreachText) {
      skippedNoContact++;
      continue;
    }
    // "You sent an attachment." (23 chars) or a bare reaction like
    // "Heheheh" isn't real content to classify from. With buildTranscript's
    // "Haven: " prefix (7 chars), "You sent an attachment." becomes
    // exactly 30 — a 30-char bar let it through and the classifier's
    // inherent non-determinism on that near-empty input gave a different
    // answer each run (Martim Saudade e Silva: "parceiro" in a dry-run,
    // "influencer" moments later in --apply, on the SAME input — caught
    // in production 2026-09-21, corrected by hand). 60 gives real margin;
    // every genuine outreach template seen in production is 300+ chars.
    // Same bar as the live cron's MIN_OUTREACH_TEXT_LENGTH.
    if (outreachText.length < 60) {
      skippedNoContact++;
      continue;
    }

    const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;

    // Cascaisnews: not outreach at all — a courtesy "thank you for the
    // story mention" to a local press/media account. Genuinely neither
    // parceiro nor influencer in the outreach-intent sense; the binary
    // classifier has no third option and guessed influencer. Correctly
    // stays a Partner Pipeline (media/press) contact — found reviewing
    // the dry-run output 2026-09-21, excluded by name rather than
    // generalizing the prompt for a one-off case.
    if (name === "Cascaisnews") {
      confirmedPartner++;
      continue;
    }

    try {
      const intent = await classifyOutreachIntent(outreachText);
      if (intent === "parceiro") {
        confirmedPartner++;
        continue;
      }

      // intent === "influencer" — move it.
      console.log(`[${apply ? "moving" : "dry-run would move"}] ${name} (${entry.notionPageId}) parceiro -> influencer`);
      if (!apply) {
        moved++;
        continue;
      }

      const handle = contact.username ? `@${contact.username}` : "sem @ (só nome no Instagram)";
      const origem = `Instagram DM · ${handle} · ${contact.messageCount} mensagens · contacto ${contact.id}`;
      const newPageId = await createInfluencer(
        name,
        "Unassigned",
        origem,
        "Instagram DM",
        contact.lastMessageAt,
        "Contactado",
      );
      await archivePage(entry.notionPageId);
      existingInfluencers.push({ id: newPageId, name });

      state[contactId] = {
        ...entry,
        classification: "influencer",
        notionPageId: newPageId,
        classifiedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
      moved++;
    } catch (err) {
      console.error(`  fail — ${contactId}:`, err.body ?? err.message);
      failed++;
    }
  }

  console.log(
    `\n${moved} ${apply ? "moved to Influencer Pipeline" : "would be moved"}, ${confirmedPartner} confirmed correctly in Partner Pipeline, ${skippedNotColdOutreach} skipped (real inbound parceiro, not cold-outreach), ${skippedNoContact} skipped (no contact/transcript), ${failed} failed.`,
  );
  if (!apply) console.log("Re-run with --apply to actually move pages.");
}

main().catch((err) => {
  console.error("reclassify failed:", err.body ?? err.message);
  process.exit(1);
});
