# haven-va — cost & latency research, 2026-05-15

Scope: read-through of `src/bot/assistant.ts`, `src/server.ts`, all `src/crons/*.ts`, `src/prompts/`, `src/notion.ts` (cache + content-cal + open-tasks paths), and `src/bot/{index,history,dm,draft-followup}.ts`. Pricing verified at `platform.claude.com/docs/.../pricing` on 2026-05-15. Companion failure-mode audit at `docs/failure-modes-audit-2026-05-15.md` (not duplicated here).

## 1. Cost baseline

### Pricing (verified — Claude Haiku 4.5, USD per million tokens)

| Lane | Price |
|---|---|
| Base input | $1.00 |
| 5-min cache write | $1.25 (1.25× input) |
| 1-hour cache write | $2.00 (2× input) |
| Cache read | $0.10 (0.10× input) |
| Output | $5.00 |
| Batch API (input/output) | $0.50 / $2.50 (-50%) |

Tool-use overhead with `tool_choice: "auto"`: **+346 tokens** baked into every request as a hidden system block.

### Token accounting for one user message

Heuristic: ~3.5 chars/token for PT-heavy text. The hot-path file sizes and call-site behavior:

| Component | Source | Bytes | ≈ tokens | Lane |
|---|---|---|---|---|
| `assistant.md` system prompt | `src/prompts/assistant.md` (9,622 B) | 9,622 | **~2,750** | cached |
| Tool definitions (13 tools) | `assistant.ts:49-347` (~11 KB of JSON-schema after stringification) | ~11,000 | **~3,000** | **NOT cached today** |
| Anthropic tool-use system block | hidden | — | **346** | uncached |
| Injected user-message context (typical) | `buildUserMessage` `assistant.ts:399-477` | varies | **600–1,400** | uncached |
| User text itself | | varies | **20–80** | uncached |
| Output (one tool call + confirmation result fed back) | | | **50–150** | output |

Per-message context block breakdown (verified at `bot/index.ts:422-453` and `assistant.ts:399-477`):

- Datetime header: ~70 tokens
- Recent conversation: `getPriors()` up to 5 turns (`history.ts:16`), ~100–300 tokens
- `lastBotReplies`: 50–200 tokens
- `repliedToText` (optional): 0–100 tokens
- Content calendar (`index.ts:427-435`): regex-gated, but when it fires `getContentCalendarRows` returns **the entire DB unfiltered** (`notion.ts:1263-1296`) → easily **500–2,000+ tokens**
- Open tasks: `getOpenTasksFor(sender)` returns **all** non-`Feito`/non-`Cancelado` rows, unbounded (`notion.ts:836-839`, `751-806`) → 100–500 tokens currently
- Calendar names + list names: 30–80 tokens

### Per-message cost

```
Warm cache, no content cal, 1 iteration:
  Uncached input:  346 + 1,000 = 1,346 tokens × $1/MTok      = $0.00135
  Cached read:                   2,750         × $0.10/MTok  = $0.00028
  Output:                          120         × $5/MTok     = $0.00060
  Tool result fed back:             50         × $1/MTok     = $0.00005
                                                              ─────────
                                                              ≈ $0.0023
```

Realistic operating-band per message:

| Scenario | $/msg |
|---|---|
| Warm cache, no content cal, 1 iter | **$0.005** |
| Cold cache (first msg of day) | **$0.008** |
| Warm cache + content cal + 2 iter | **$0.012** |
| Bad day (cold + content cal + 3 iter) | **$0.025** |

**Tool definitions are not cached today** — they cost the full 3,000 tokens at input rate on every single call: ~$0.003 per message. Biggest single line item, larger than everything else combined.

### Crons

Only `pipeline-alerts.ts` invokes Claude (via `draft-followup.ts:73`). All others (`reminders`, `daily-madalena`, `monday-priorities`, `friday-balance`, `weekend-brief`) are pure Notion + Telegram. `draft-followup` cost: ~$0.001/draft, ~2–8 drafts/day → **<$0.01/day from crons**.

### Rollup

At 30 user msgs/day across 3 founders, warm cache on most:

```
30 msgs × $0.006 avg = $0.18/day → $5.70/month
+ crons              = $0.30/month
                     ─────────
                     ≈ $6/month
```

Peak (60 msgs/day, half with content cal): ~$12/month. **Realistic band: $5–15/month** of Anthropic spend.

Small absolute money. Interesting questions: (a) how does this grow if usage triples, (b) where is the latency.

---

## 2. Optimization opportunities (ROI-ranked)

| # | Change | Est. $ saved (% of current) | Effort | UX risk |
|---|---|---|---|---|
| 1 | **Cache tool definitions** | **−50% input cost (~$2.50/mo)** | **0.5h** | none |
| 2 | Trim system prompt, kill dead prompts | −15% input | 1h | low |
| 3 | Cap+filter content calendar context | −10% overall; cuts bad-day cost ×3 | 1h | low |
| 4 | Cap open-tasks injection at N=15 | −5% input; future-proofs growth | 0.5h | low |
| 5 | Stream the final text reply | latency only — no $ | 1h | none |
| 6 | Fast-path regex bypass | −5–10% of calls | 3h | medium |
| 7 | Lower `MAX_ITERATIONS` 5→3 | bounds worst case | 0.25h | low |
| 8 | 1-hour cache TTL | likely **negative** for this bot | — | — |
| 9 | Batch API for `draft-followup` | ~$2/year saved | not worth it | — |
| 10 | Swap to cheaper model | 20% maybe, risk too high | — | high |
| 11 | Parallel-execute multi-tool responses | latency only | 2h | low |

### Detail on the wins

**1. Cache tool definitions.** Verified at `assistant.ts:1011-1017` — only the system-prompt text block has `cache_control: { type: "ephemeral" }`. The `tools` array (`assistant.ts:1044`) is passed without cache hints. ~3,000 tokens of stable JSON-schema billed at $1/MTok every request = the single largest line item. Anthropic supports `cache_control` on tool blocks; add `cache_control: { type: "ephemeral" }` to the last tool in the array. Effect: tool defs drop from $1/MTok to $0.10/MTok on cache hit. **~$2.50/mo today, scales linearly.** Half a day's coffee. Do it.

**2. System prompt diet + delete dead prompts.** `assistant.md` is 9.6 KB / ~2,750 tokens. Mostly well-spent, but the "Quando agir" section repeats tool/field details already in tool schemas — could be condensed by ~30% (~800 tokens) with no quality loss. Cached lane impact: ~$0.07/mo on reads, ~$0.30/mo on writes. Plus delete confirmed-dead files (`prompts/{launch-templates,feedback-examples,regex-keywords,multi-intent,extract-edit}.*`) — they don't affect runtime cost, just signal cleanliness.

**3. Cap and pre-filter content calendar.** `notion.ts:1263-1296` returns the entire calendar with no filter. If the DB has 50 posts, that's ~1,500 tokens per matching message. The regex (`index.ts:427`) is overbroad too. Add a Notion `filter` for `publishDate` within ±30 days + hard slice to 20 rows. Tighten regex to require co-occurrence with calendar verbs ("agenda", "publica", "adiciona", "muda"). Saves ~10K tokens/day = ~$0.30/mo. Bigger gain: removes a chunk of variance from "bad day" cost.

**4. Cap open-tasks.** `getOpenTasksFor` (`notion.ts:836-839`) has no cap. Today fine; future-proofs at 50+ open tasks. Slice top 15 by `deadline asc, priority asc`.

**5. Streaming.** Verified: `messages.create` (`assistant.ts:1040`), not `messages.stream`. Doesn't reduce cost. Today's first-token latency from Haiku is ~600–900 ms on warm cache; full completion 1.5–2.5 s. Streaming via `client.messages.stream()` + placeholder Telegram message edited with deltas would feel snappier on longer replies. **Caveat:** dominant output mode is tool-use; tool action confirmations come from `ctx.reply` inside tool handlers, not from the model's final text. Streaming only helps for the informational branch.

**6. Fast-path regex bypass.** Don't build this yet. Premium engineering for sub-€2/mo savings, and the failure modes (regex fires on wrong intent) hurt UX more than the savings help cost. Reconsider after a week of `log.info("assistant.handled")` analysis to see actual phrasing distributions.

**7. Lower `MAX_ITERATIONS`.** `assistant.ts:1031` caps at 5. From the audit, Haiku occasionally returns empty `input` and burns iterations. Real-world is probably 1 iteration for ~80% of messages, 2 for the rest. Drop to 3. Bounds worst case. 15-minute change.

**8. 1-hour cache TTL.** Math: 1h write = $2.00/MTok, 5m write = $1.25/MTok. For sparse traffic (gaps >5 min between messages — most of the day for this bot), 5-min writes get paid for and never read from. The 1h cache only wins if you'll read it ≥2 times within the hour. At ~30 msgs/day spread over 14 active hours, inter-message gap averages ~30 min. **Stick with 5-min ephemeral. A 1h TTL would likely *increase* cost.**

**11. Parallel tool calls.** `assistant.ts:1076-1090` iterates `toolCalls` with `await dispatchTool` *serially*. When Claude returns two `tool_use` blocks in one response, each Notion round-trip serializes. 200–500 ms each × 2 = 600–1000 ms wasted. Wrap in `Promise.all` for parallel-safe pairs. Caveat: some pairs have ordering dependencies (`create_task` → `create_reminder` with `task_page_id`) — the prompt already tells the model these must be sequential. For parallel-safe cases, group and parallelize.

---

## 3. Latency

Where time goes for a typical group message that triggers `create_task`:

| Step | Time |
|---|---|
| Telegram long-poll round-trip (`server.ts:78`, no webhooks) | 200–800 ms |
| `getOpenTasksFor` Notion query (60s cache hit ≈ 0, miss ≈ 300–600 ms) | 0–600 ms |
| Conditional `getContentCalendarRows` (no cache) | 0 or 400–800 ms |
| Optional `calendar.listAllCalendars` + `notion.getListNames` | 100–400 ms |
| First Claude call (Haiku, warm cache) | 800–1,800 ms |
| Tool execution (Notion write) | 200–500 ms |
| Second Claude call to close out | 600–1,200 ms (if text confirmation) |
| `ctx.reply` to Telegram | 100–300 ms |
| **Total** | **~2.5–5 s typical, ~7 s worst** |

### Latency moves

- **Stream the model output.** First-token <1 s; user sees "typing" instead of 3 s silence.
- **Parallelize pre-call Notion fetches.** `calendar.listAllCalendars()` and `notion.getListNames()` (`assistant.ts:1019-1022`) run sequentially. Wrap in `Promise.all`. Save 100–300 ms.
- **Parallelize parallel-safe tool calls** (Optimization #11). Save 200–500 ms on multi-tool turns.
- **Webhook mode for Telegram.** Long-polling adds 200–800 ms of slop. Webhook needs HTTPS reachable from Telegram — non-trivial from a Synology behind a home router. Defer.
- **Pre-warm cache on startup.** Issue a tiny `messages.create` with system prompt + tools at server start. Costs one cache-write (~$0.004) once per restart; the *first user message of the day* then gets a cache hit. Daily-ish restart pattern → free latency win.
- **Realistic target:** with streaming + parallel pre-fetches + cached tools: perceived response <2 s in 80%, <3 s in 95%. Worst-case stays ~5 s — fine.

### Notion N+1 audit

`reminders.ts`, `pipeline-alerts.ts` have serial loops but volume is low (<5 fires per tick) and crons are async/unobserved — latency doesn't matter. Skip.

---

## Notion CLI

It exists and is official — Notion announced the Developer Platform on **2026-05-13**, two days ago. Repo: `makenotion/skills`. Useful here as a pre-deploy schema-drift check (already covered in the failure-mode audit, not repeating). Not a cost/latency move — a safety move.

---

## Recommended order of operations

1. **Today (30 min):** Add `cache_control: { type: "ephemeral" }` to last entry in `TOOLS` array (`assistant.ts:347`). Verify cache hits via `response.usage.cache_read_input_tokens`. **Single biggest win.**
2. **Today (30 min):** Lower `MAX_ITERATIONS` from 5 to 3 (`assistant.ts:1031`).
3. **This week (1 h):** Filter + cap `getContentCalendarRows` to ±30 days, max 20 rows. Tighten calendar-keyword regex in `bot/index.ts:427`.
4. **This week (1 h):** Slice `getOpenTasksFor` at 15 rows by deadline. Parallelize pre-call fetches in `assistant.ts:1019-1022`.
5. **Polish (1 h):** Switch `messages.create` → `messages.stream` + Telegram placeholder edit pattern.
6. **House-cleaning:** Delete dead prompt files (confirmed unused by grep).

**Total: ~4 hours of work cuts spend roughly in half, halves perceived latency, and removes ~25 KB of dead code from the repo.** Skip the fancy stuff (batch API, model swap, regex fast-paths) — sub-€2/mo is not worth the failure-mode surface.

Sources: [Anthropic pricing](https://platform.claude.com/docs/en/docs/about-claude/pricing), [Notion Developer Platform launch (2026-05-13)](https://www.notion.com/releases/2026-05-13), [makenotion/skills](https://github.com/makenotion/skills/blob/main/skills/notion-cli/SKILL.md).
