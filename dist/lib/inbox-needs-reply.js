/**
 * Who is waiting for a reply on Instagram. Step 3 of haven-studio's Instagram DM plan
 * (haven-studio docs/knowledge/messaging/README.md, recipe A).
 *
 * The studio view va.inbox_threads already applies the rules (we spoke last, a reaction, a GIF, an
 * emoji-only message: not owed). What is left, rule_state = 'candidate', is judged here by Claude
 * Haiku with src/prompts/inbox-needs-reply.md, and the verdict goes to va.inbox_thread_labels
 * (insert-only). A failed call writes nothing: the thread stays 'unlabelled', which the digest
 * treats as needs_reply. A missed customer costs more than a second look.
 *
 * Madalena tunes the prompt; the rules live in the studio view.
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./log.js";
import { query } from "./studio-db.js";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const PROMPT_VERSION = "inbox-needs-reply v1";
const CATEGORIES = ["booking_or_price", "intro_lead", "member_issue", "complaint", "collab_or_spam", "other"];
const clamp01 = (n) => {
    const x = typeof n === "number" ? n : Number(n);
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0.5;
};
/** The model's one-line JSON, or null when it is not usable (then nothing is written). */
export function parseVerdict(text) {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m)
        return null;
    let j;
    try {
        j = JSON.parse(m[0]);
    }
    catch {
        return null;
    }
    if (j.state !== "needs_reply" && j.state !== "closed")
        return null;
    const category = CATEGORIES.includes(String(j.category)) ? j.category : "other";
    return {
        state: j.state,
        category,
        urgency: clamp01(j.urgency),
        confidence: clamp01(j.confidence),
        reason: String(j.reason ?? "").slice(0, 300),
    };
}
/** Oldest first so the transcript reads top to bottom; we = the studio. */
export function buildTranscript(msgs) {
    return msgs
        .map((m) => `${m.direction === "out" ? "The Haven" : "Pessoa"} (${m.sent_at.slice(0, 16)}): ${m.text?.trim() || "[foto, vídeo ou partilha]"}`)
        .join("\n");
}
const who = (r) => r.username ? `@${r.username}` : r.display_name ?? "(sem nome)";
function hoursBetween(from, to) {
    return Math.round((to.getTime() - from.getTime()) / 3_600_000);
}
/** The Telegram digest for Madalena, pt-PT, plain text. Empty list = no message. */
export function formatDigest(rows, now, shadow) {
    if (rows.length === 0)
        return null;
    const lines = rows.map((r) => {
        const waited = hoursBetween(new Date(r.last_in_at), now);
        const closes = hoursBetween(now, new Date(r.window_closes_at));
        const window = closes > 0
            ? `janela fecha em ${closes}h`
            : `janela de 24h fechou: só resposta escrita por ti até ${new Date(r.human_agent_until).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", timeZone: "Europe/Lisbon" })}`;
        const kind = r.state === "unlabelled" ? "por classificar" : (r.category ?? "other").replace(/_/g, " ");
        const lead = r.is_lead ? " · lead" : "";
        const reason = r.reason ? `\n   ${r.reason}` : "";
        return `• ${who(r)}${lead} · ${kind} · há ${waited}h · ${window}${reason}`;
    });
    const head = `💬 Instagram: ${rows.length} ${rows.length === 1 ? "pessoa à espera" : "pessoas à espera"} de resposta`;
    const foot = shadow ? "\n\nSemana de teste: se alguma estiver mal (já respondida, ou devia estar aqui e não está), diz-me qual." : "";
    return `${head}\n\n${lines.join("\n")}${foot}`;
}
let client = null;
let prompt = null;
async function judge(transcript) {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error("ANTHROPIC_API_KEY is not set");
        client = new Anthropic({ apiKey });
    }
    prompt ??= readFileSync(new URL("../prompts/inbox-needs-reply.md", import.meta.url), "utf8");
    try {
        const res = await client.messages.create({
            model: process.env.INBOX_AGENT_MODEL ?? DEFAULT_MODEL,
            max_tokens: 200,
            system: prompt,
            messages: [{ role: "user", content: transcript.slice(-8000) }],
        });
        const block = res.content.find((b) => b.type === "text");
        return block && block.type === "text" ? parseVerdict(block.text) : null;
    }
    catch (err) {
        log.warn("inbox_needs_reply.request_failed", { message: err instanceof Error ? err.message : String(err) });
        return null;
    }
}
/** Judge every candidate from the last 7 days (HUMAN_AGENT window) that has no verdict yet. */
export async function labelCandidates(limit = 30) {
    const candidates = await query(`select contact_id, username, display_name, is_lead, last_in_at::text as last_in_at
       from inbox_threads
      where rule_state = 'candidate' and state = 'unlabelled' and last_in_at > now() - interval '7 days'
      order by last_in_at
      limit $1`, [limit]);
    let judged = 0;
    let failed = 0;
    for (const c of candidates) {
        const msgs = await query(`select direction, text, sent_at::text as sent_at from inbox_messages
        where contact_id = $1 order by sent_at desc limit 10`, [c.contact_id]);
        const verdict = await judge(buildTranscript(msgs.reverse()));
        if (!verdict) {
            failed += 1;
            continue;
        }
        await query(`insert into inbox_thread_labels (contact_id, last_in_at, state, category, urgency, confidence, reason, labelled_by)
       values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8)`, [c.contact_id, c.last_in_at, verdict.state, verdict.category, verdict.urgency, verdict.confidence, verdict.reason, PROMPT_VERSION]);
        judged += 1;
    }
    return { judged, failed };
}
/** Threads owed a reply that a person can still answer (HUMAN_AGENT: 7 days), oldest first. */
export async function fetchWaiting() {
    return query(`select username, display_name, is_lead, last_in_at::text as last_in_at, window_closes_at::text as window_closes_at,
            human_agent_until::text as human_agent_until, state, category, urgency, reason
       from inbox_threads
      where platform = 'instagram' and state in ('needs_reply', 'unlabelled') and human_agent_until > now()
      order by last_in_at`);
}
