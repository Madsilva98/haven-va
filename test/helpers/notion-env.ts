// Side-effect import: sets the two env vars src/notion.ts requires at
// module-load time (it throws otherwise), so tests can import modules that
// transitively import notion.ts (e.g. src/bot/remind.ts) without needing
// real Notion credentials. Never touches the network — nothing in these
// tests calls into the Notion client itself.
process.env.NOTION_API_KEY ??= "test-dummy-key";
process.env.NOTION_BACKLOG_DB_ID ??= "test-dummy-backlog-db";
