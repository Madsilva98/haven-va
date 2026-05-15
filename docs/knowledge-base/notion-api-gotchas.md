# Notion API gotchas

Reference for everything the bot needs to know about Notion's API surface. Built from a full read-through of developers.notion.com on **2026-05-15** — every claim is cited with a URL. Update this file when you hit a new 4xx, when Notion ships a new version, or when you discover a pattern the docs warn about.

## ⚠️ TL;DR for the next session

1. **`databases.query()` is officially deprecated** as of API version **2025-09-03**. Replacement: `dataSources.query()`. ([post-database-query](https://developers.notion.com/reference/post-database-query))
2. **The bot will break silently the moment any DB gets a second data source.** Quote from Notion: *"If your connection is still using a previous API version and a user adds another data source to a database, the following API actions will fail: Create page when using the database as the parent, Database read/write/query, Writing relation properties that point to that database."* ([upgrade-guide-2025-09-03](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03)) **A user can add a second data source from the Notion UI in 3 clicks.** This is the single most urgent thing to harden.
3. **Current API version: `2026-03-11`.** Two breaking changes since 2025-09-03: `archived` → `in_trash`, and `after` parameter → `position` object on append-children. ([changes-by-version](https://developers.notion.com/reference/changes-by-version))
4. **Webhooks exist and `data_source.schema_updated` solves drift detection.** Sub-minute push instead of cron polling. HMAC-SHA256 signed, up to 8 retries over 24h. ([webhooks-events-delivery](https://developers.notion.com/reference/webhooks-events-delivery))
5. **Rate limit: 3 req/sec per connection.** 429s come with a `Retry-After` header — the bot's hardcoded 0.5s first retry is shorter than Notion typically asks and will earn another 429. ([request-limits](https://developers.notion.com/reference/request-limits))
6. **409 `conflict_error` is a real distinct status** the bot should retry (1-2 attempts, ~1s backoff). Today `withRetry` skips it. ([status-codes](https://developers.notion.com/reference/status-codes))
7. **Empty string is invalid.** Always use `null` to clear a property value. ([reference/intro](https://developers.notion.com/reference/intro))

## 1. The data model in 2026

**Database (container).** Has `object: "database"`, `id`, `title`, `description`, `parent`, `icon`, `cover`, `url`, `in_trash`, `is_inline`, `is_locked`, and a `data_sources` array. **As of 2025-09-03 the database object no longer carries the `properties` schema.** ([database](https://developers.notion.com/reference/database))

**Data source (schema + rows).** Has `object: "data_source"`, `id`, `title`, `description`, `parent`, `database_parent`, `in_trash`, and `properties`. The `properties` field maps property names ("Título", "Owner", etc.) to property objects with `id`, `name`, `type`, and per-type config. ([data-source](https://developers.notion.com/reference/data-source))

**Page.** Lives under a data source. New parent shape: `{ type: "data_source_id", data_source_id: "..." }`. Accepted on older API versions too, so you can migrate before bumping the version header.

**The relationship in one sentence**: "A database is a parent of one or more data sources, each of which parents zero or more pages."

### What this means for haven-va's current code

The bot uses `client.databases.query(databaseId)` everywhere in `src/notion.ts`. This currently works because each of the 10 DBs has exactly one data source — but:

- **The endpoint is deprecated.** Will eventually be removed (no date announced, but Notion's deprecation policy is to "communicate with affected users and provide a time window").
- **The single-data-source assumption is fragile.** If anyone adds a second data source to *any* DB via the Notion UI, every query/page-create/relation-write against that DB starts returning errors saying "Databases with multiple data sources are not supported in this API version." Response payload includes the offending data source IDs.

## 2. Authentication & versioning

**Token model.** Three types:
- **Internal connection tokens** — workspace-scoped, static. This is what haven-va uses (env var `NOTION_API_KEY`).
- **PATs (Personal Access Tokens)** — user-scoped, static. For scripts.
- **OAuth tokens** — per-user, with refresh tokens via `POST /v1/oauth/token` grant_type=refresh_token.

**Required headers on every API call:**
```
Authorization: Bearer <token>
Notion-Version: 2026-03-11
Content-Type: application/json
```

Missing the version header → HTTP 400 `missing_version`.

**Versioning.** Date-named. Current is `2026-03-11`. Predecessors that mattered:
- `2025-09-03` — databases ⇄ data sources split (current breaking trap)
- `2022-06-28` — last "old data model" version
- `2021-05-13` — `text` renamed to `rich_text`

**SDK requirement.** `@notionhq/client` must be **v5.0.0+** to expose `notion.dataSources.*` alongside `notion.databases.*`. Verify in `package.json` — anything below 5.x can't do data-source operations even with the right version header.

## 3. Endpoint catalog (what the bot uses + what it should)

Base URL: `https://api.notion.com`.

### Database container
- `GET /v1/databases/{database_id}` — returns container metadata + the `data_sources` array. **Does not return `properties` anymore.** ([retrieve-a-database](https://developers.notion.com/reference/retrieve-a-database))
- `PATCH /v1/databases/{database_id}` — update container-level fields (title, description, icon, cover, is_inline, parent, in_trash). Schema changes go to the data source endpoint.
- `POST /v1/databases` — create. Schema goes under `initial_data_source.properties`.

### Data source (the new core)
- `GET /v1/data_sources/{data_source_id}` — **the schema-introspection call.** Returns full data source including `properties`. ([retrieve-a-data-source](https://developers.notion.com/reference/retrieve-a-data-source))
- `POST /v1/data_sources/{data_source_id}/query` — replaces `databases.query()`. Same filter/sort schema. ([query-a-data-source](https://developers.notion.com/reference/query-a-data-source))
- `PATCH /v1/data_sources/{data_source_id}` — modify schema (add/rename properties, edit select options).

### Pages
- `POST /v1/pages` — body `parent` (`{ type: "data_source_id", data_source_id }` now preferred), `properties` keyed by property names, optional `children` xor `markdown` xor `template`, optional `icon`/`cover`. Cannot set on create: `rollup`, `created_by`, `created_time`, `last_edited_by`, `last_edited_time`. ([post-page](https://developers.notion.com/reference/post-page))
- `PATCH /v1/pages/{page_id}` — patchable: `properties` (only when parent is a data source), `icon`, `cover`, `is_locked`, `in_trash`, `is_archived`, `erase_content`, `template`. **Set to `null` to clear, never empty string.** ([patch-page](https://developers.notion.com/reference/patch-page))
- `GET /v1/pages/{page_id}/properties/{property_id}` — paginate large properties (rich_text, people, relation > 25 entries).

### Blocks
- `GET /v1/blocks/{block_id}/children` — list, paginated.
- `PATCH /v1/blocks/{block_id}/children` — append. **Uses `position` object** in 2026-03-11 (replaced `after` field).
- `PATCH /v1/blocks/{block_id}` — update.
- `DELETE /v1/blocks/{block_id}` — delete.

### Comments
- `POST /v1/comments` — body: exactly one of `parent.page_id`, `parent.block_id`, `discussion_id`; either `rich_text[]` or `markdown` (exclusive); optional `display_name`; optional `attachments[]` (≤3, each `{ file_upload_id }`). Requires *insert comments* capability. ([create-a-comment](https://developers.notion.com/reference/create-a-comment))
- `GET /v1/comments?block_id={id}` — list open comments (resolved comments **not retrievable**).
- `PATCH` / `DELETE` — own connection only.

### File uploads
- `POST /v1/file_uploads` — body: `mode` (`single_part` ≤20MB default, `multi_part` >20MB, `external_url`), `filename`, `content_type`, `number_of_parts`, `external_url`. Returns `{ id, status: "pending", upload_url, complete_url, expiry_time }`. ([file-upload](https://developers.notion.com/reference/file-upload))
- `POST {upload_url}` — multipart/form-data send bytes.
- `POST {complete_url}` — finalize multi-part.
- Once `status === "uploaded"`, reference via `{ type: "file_upload", file_upload_id }` in a property or block.

### Search
- `POST /v1/search` — body: `query` (title substring), `filter: { property: "object", value: "page" | "data_source" }` (was `"database"`, now `"data_source"`), `sort`, pagination. **Searches titles only**, not body text. May return `request_status: { incomplete_reason: "query_result_limit_reached" }`. ([post-search](https://developers.notion.com/reference/post-search))

### Webhooks
- Configured in the Developer Portal under the connection's Webhooks tab.
- One-time verification handshake: Notion POSTs `verification_token`; you echo it back in the UI.
- Event POSTs include header `X-Notion-Signature` (HMAC-SHA256 of body with the subscription secret).
- Delivery: at-most-once with exponential retry up to 8 attempts over ~24h. Most events arrive <1 min, soft SLA "within 5 minutes." Aggregated events batch rapid changes.

**Events relevant to haven-va:**
- `page.created`, `page.content_updated`, `page.properties_updated`, `page.moved`, `page.deleted`, `page.undeleted`, `page.locked`, `page.unlocked`
- `data_source.created`, **`data_source.schema_updated`**, `data_source.content_updated`, `data_source.moved`, `data_source.deleted`, `data_source.undeleted`
- `comment.created`, `comment.updated`, `comment.deleted`

**Caveat:** events tell you *something* changed but **don't include the new content** — you need a follow-up API call.

## 4. Property types

23 property types. Highlights for haven-va:

| Type | Read shape | Write shape | Notes |
|---|---|---|---|
| `title` | `{ title: RichText[] }` | `{ title: [{ text: { content: "..." } }] }` | **Exactly one per data source.** Not interchangeable with `rich_text`. |
| `rich_text` | `{ rich_text: RichText[] }` | Same with `rich_text` key | Full array overwrite. |
| `select` | `{ select: { id, name, color } }` or `null` | `{ select: { id } \| { name } \| null }` | **Commas invalid in option names.** New option auto-created if writer has schema-write access. |
| `multi_select` | `{ multi_select: [{...}] }` | Array overwrites whole value | Max 100. |
| `status` | `{ status: { id, name, color } }` | `{ status: { id } \| { name } }` | **Schema carries `groups`** which select doesn't — this is how you detect status-vs-select. |
| `date` | `{ date: { start, end, time_zone } }` | `{ date: { start: "YYYY-MM-DD", end?, time_zone?: "Europe/Lisbon" } }` | ISO-8601. |
| `relation` | `{ relation: [{ id }], has_more }` | `{ relation: [{ id }] }` | **Schema now points at `data_source_id`, not database_id.** Target data source must be shared with the connection or relations are silently omitted. |
| `files` | `{ files: [{ name, type, external? \| file? \| file_upload? }] }` | Array overwrite; `{ name, external: { url } }` or `{ file_upload: { id }, name? }` | Omitting removes. Max 100. |
| `url`, `email`, `phone_number` | `{ url: string \| null }` etc. | Same | **Empty string forbidden — use `null`.** |
| `verification` | `{ verification: { state, date, verified_by } }` | Write `state` only | Not used by haven-va today. |

### Read-only (cannot be in POST/PATCH `properties` body)
`rollup`, `formula`, `unique_id`, `created_time`, `created_by`, `last_edited_time`, `last_edited_by`.

### Naming gotchas
- **`rich_text` vs `text`**: the type was renamed to `rich_text` in `2021-05-13`. If you see `text` somewhere, it's stale code or an extremely old `Notion-Version`.
- **`title` is structurally rich_text but keyed under `title`, not `rich_text`.**

## 5. Rate limits & retry strategy

**Documented limit:** 3 req/sec average per connection (bursts allowed). ([request-limits](https://developers.notion.com/reference/request-limits))

**On 429:** response carries `Retry-After: <seconds>` header. Notion's recommended pattern is to honor it. The bot's 0.5s/2s/8s ladder will almost certainly hit another 429 on the first retry under any real rate-limit event.

### Payload limits

| Constraint | Limit |
|---|---|
| Total payload | 500 KB |
| Blocks per payload | 1000 |
| Block children array | 100 elements |
| Rich text content / URL | 2000 chars |
| Equation | 1000 chars |
| Email / phone | 200 chars |
| Multi-select options | 100 |
| Relation array (write) | 100 |
| People mentions | 100 |

### What `withRetry` should look like

```
On 429: read `Retry-After` header, sleep that long, retry (up to 3x)
On 502/503/504: 1s/3s/10s exponential, up to 5 attempts (Notion incidents can persist for minutes)
On 409: 1s/2s, up to 2 attempts (concurrent write collision)
On 5xx other: 1s/3s/10s, up to 3 attempts
On 400/401/403/404: never retry — bug or permission, fail loud
```

Today's `withRetry` (`src/notion.ts:72-80`): 3 attempts at 0.5s/2s/8s on 429/5xx only. **Misses 409 entirely, and the 0.5s first retry on 429 is too aggressive.**

## 6. Schema introspection (the drift-detection sequence)

To get every property name + type for every haven-va database:

```
for each known database_id:
  database = GET /v1/databases/{database_id}     # returns container + data_sources array
  if database.data_sources.length !== 1:
    alert("Multi-source database detected: " + database.title)   # the canary
  for each ds in database.data_sources:
    live = GET /v1/data_sources/{ds.id}          # returns full properties schema
    diff(expected[database.title], live.properties)
```

The diff matters per type:
- `select.options[]` / `multi_select.options[]` — `{ id, name, color }`. Drift = name change, case change, accent change.
- `status.options[]` + `status.groups[]` — Madalena's recent migration.
- `relation.data_source_id` — re-pointing a relation breaks the bot's joined reads.
- `number.format` — currency formatting changes (cosmetic, but flag-worthy).

### Same job, two implementations

| Approach | Latency | Cost | Use when |
|---|---|---|---|
| Pre-deploy cron + `npm run check:schema` | block deploys with drift | Polls on every deploy | Deploys are infrequent; want a hard fail-loud gate |
| `data_source.schema_updated` webhook subscription | sub-minute push | Free | You can host a public HTTPS endpoint |

The bot doesn't have an HTTPS endpoint today (long-polling only). To use the webhook approach, you'd need to expose one — either via Tailscale Funnel, Cloudflare Tunnel, or by switching the bot architecture to webhook-mode. **Recommend the pre-deploy script for now; revisit when there's a reason to add a public endpoint anyway.**

## 7. Errors & status codes

Response body shape: `{ object: "error", status, code, message, request_id? }`.

| HTTP | code | When | What haven-va should do |
|---|---|---|---|
| 200 | — | success | proceed |
| 400 | `invalid_json` | body not JSON | bug; fail loud |
| 400 | `invalid_request_url` | malformed URL | bug; fail loud |
| 400 | `invalid_request` | endpoint not supported | bug; fail loud |
| 400 | `invalid_grant` | bad/expired auth | regenerate; **never retry** |
| 400 | `validation_error` | request shape wrong | parse `message`, log request, **don't retry blindly**. This is what you get for wrong property name, missing select option, empty-string-where-null-required. |
| 400 | `missing_version` | no `Notion-Version` header | bug; add header |
| 401 | `unauthorized` | bad token | rotate; never retry |
| 403 | `restricted_resource` | token lacks capability or page not shared | alert; never retry |
| 404 | `object_not_found` | wrong ID or unshared | alert; never retry |
| **409** | **`conflict_error`** | **concurrent write collision** | **retry 1-2x with ~1s backoff — NOT done today** |
| 429 | `rate_limited` | over 3/s | **honor `Retry-After`, then retry** |
| 500 | `internal_server_error` | unexpected | retry with backoff; alert if persists |
| 502/503/504 | gateway/unavailable/timeout | Notion down or query too slow | retry with longer backoff |
| 503 | `database_connection_unavailable` | Notion DB unreachable | retry with longer backoff |

## 8. Documented warnings (the docs explicitly call these out)

- **Linked databases are unsupported.** The integration must be granted access to the original data source, not the linked surface. ([retrieve-a-database](https://developers.notion.com/reference/retrieve-a-database))
- **Empty string is invalid.** Use `null` to clear. ([reference/intro](https://developers.notion.com/reference/intro))
- **Related DBs must be shared.** Otherwise relation properties silently return partial data with no warning.
- **Wiki databases can't be created via API.**
- **Templates apply asynchronously.** Creating a page from a template returns immediately with a blank page; content arrives a moment later. Don't immediately update its blocks.
- **`children` is mutually exclusive with `template` and `markdown`.** Pick one mode per create.
- **People property capped at 25 on retrieve-page.** Use `GET /v1/pages/{id}/properties/{property_id}` for full list.
- **`archived` is deprecated; use `in_trash`.** Removed from request/response in `2026-03-11`.
- **`after` parameter on append-children replaced by `position` object** in `2026-03-11`.
- **The `data_sources` array order is not stable.** Don't index by position; match by name or stored ID.

## 9. Recommendations for haven-va (ranked)

| # | Action | Urgency | Effort | Why |
|---|---|---|---|---|
| 1 | **Migrate to data-sources API** — bump `@notionhq/client` to v5+, set `notionVersion: "2026-03-11"`, swap `databases.query()` → `dataSources.query()` everywhere, cache data_source_id per DB | **high** | medium (mechanical) | A single Notion-UI click adding a second data source = bot dies silently |
| 2 | **Detect multi-source DBs at startup** — call `databases.retrieve()` once per DB on boot, log loud if `data_sources.length > 1`, refuse to start or page Madalena | **high** | small | Canary against the breaking trap until (1) is done |
| 3 | **Add 409 `conflict_error` to `withRetry`** with ~1s backoff | medium | trivial | Concurrent writes during cron windows currently lose silently |
| 4 | **Honor `Retry-After` on 429** instead of fixed 0.5/2/8s | medium | trivial | Current 0.5s first retry guarantees another 429 |
| 5 | **Pre-deploy schema check** using `dataSources.retrieve()` against `scripts/expected-schema.mjs` | medium | medium | Catches drift before it ships to production |
| 6 | **Switch property "clears" from `""` to `null`** | low | trivial audit | Silent validation_errors swallowed today |
| 7 | **Use the File Upload API** for Telegram→Notion media instead of external URLs | low | medium | Files live in Notion's CDN, no expiring URL risk |
| 8 | **Adopt `in_trash` everywhere `archived` is read** | low (unless on 2026-03-11) | trivial | Old field is `undefined` on current version |
| 9 | **Comment-on-completion** via `POST /v1/comments` when bot marks a task done | low | trivial | Audit trail inside Notion itself |
| 10 | **Replace cron schema-drift check with `data_source.schema_updated` webhook** | low | high (needs public HTTPS endpoint) | Sub-minute push; only worth it once bot needs an HTTPS endpoint for another reason |

## Sources

The full list of pages fetched (35 total) lives at the bottom of the research transcript. Highest-value ones:

- [upgrade-guide-2025-09-03](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03) — **read this first** — the data-sources migration guide
- [upgrade-faqs-2025-09-03](https://developers.notion.com/guides/get-started/upgrade-faqs-2025-09-03) — confirms old/new IDs not interchangeable, multi-source breakage timing
- [changes-by-version](https://developers.notion.com/reference/changes-by-version) — what changed in each API version
- [request-limits](https://developers.notion.com/reference/request-limits) — rate limits and payload caps
- [status-codes](https://developers.notion.com/reference/status-codes) — every HTTP status with recommended client behavior
- [webhooks-events-delivery](https://developers.notion.com/reference/webhooks-events-delivery) — full event catalog
- [retrieve-a-data-source](https://developers.notion.com/reference/retrieve-a-data-source) — schema-introspection endpoint

## Last touched

2026-05-15 — Full survey complete. The multi-source breaking trap and `databases.query()` deprecation are new findings vs the partial seed; both supersede prior plans.
