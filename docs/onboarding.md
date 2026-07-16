# Onboarding — dia 1

Checklist para correr o bot localmente pela primeira vez. Para arquitetura, lê [`knowledge-base/bot-architecture.md`](knowledge-base/bot-architecture.md) depois disto — este doc é só "pôr a correr", não "como funciona por dentro".

## 1. Clonar e instalar

```bash
git clone https://github.com/Madsilva98/haven-va.git
cd haven-va
npm install
cp .env.example .env
```

## 2. Credenciais — o que precisas e onde arranjar

Preenche `.env` à medida que avanças. Cada secção abaixo corresponde a um bloco do `.env.example`.

### Telegram

1. Fala com [@BotFather](https://t.me/BotFather) no Telegram → `/newbot` (ou usa o bot já existente do projeto, pede o token a quem já tem acesso).
2. `TELEGRAM_BOT_TOKEN` = o token que o BotFather devolve.
3. `TELEGRAM_GROUP_ID` = ID do grupo das founders. Formas de obter: adiciona o bot ao grupo, manda uma mensagem, lê `chat.id` nos logs (`bot.on("message")` regista `ctx.chat.id`).
4. `TELEGRAM_MADALENA_ID` / `TELEGRAM_MAFALDA_ID` / `TELEGRAM_BEATRIZ_ID` = IDs de utilizador Telegram de cada founder (não o `@username`). Consegue-se falando com [@userinfobot](https://t.me/userinfobot).

Sem estes IDs corretos, `isFounder()` (`src/lib/founders.ts`) ignora todas as mensagens em silêncio — é o erro mais comum de "o bot não responde nada" num ambiente novo.

### Notion

1. Cria uma integração em [notion.so/my-integrations](https://www.notion.so/my-integrations) → copia o **Internal Integration Secret** para `NOTION_API_KEY`.
2. Para cada base de dados que o bot usa (Backlog, Founder Focus, Partners, etc.), abre-a no Notion → `···` → **Connections** → adiciona a integração criada acima. Sem isto, todas as chamadas à API dessa base devolvem `401`.
3. Copia o ID de cada base (da URL, o segmento de 32 caracteres antes do `?`) para o `.env` correspondente (`NOTION_BACKLOG_DB_ID`, etc.). Só `NOTION_BACKLOG_DB_ID` é obrigatório — as restantes são opcionais, e a funcionalidade correspondente desliga-se sozinha se faltar (ver comentários no `.env.example`).
4. Schema das bases (nomes de propriedades esperados) está em [`notion-db-config.xlsx`](notion-db-config.xlsx) e é aplicado por `node scripts/setup-notion-dbs.mjs` (idempotente — corre sempre que precisares).

### Claude / Anthropic

`ANTHROPIC_API_KEY` de [console.anthropic.com](https://console.anthropic.com) → API Keys.

### Google Calendar (opcional)

Não é preciso para correr o bot — sem `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `/calendar` e `/auth` ficam simplesmente indisponíveis. Se quiseres ativar:

1. Cria um OAuth Client ID em [console.cloud.google.com](https://console.cloud.google.com) (tipo "Desktop app" ou "Web app" com `GOOGLE_REDIRECT_URI=http://localhost:3000`).
2. Preenche `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
3. Com o bot a correr, manda `/auth` em DM privada ao bot **como Madalena** (único founder autorizado a este fluxo, ver `src/bot/index.ts`). O bot devolve um link; abre, autoriza, copia o `code=` da URL de callback e cola de volta na DM.
4. O token de refresh fica guardado em `DATA_DIR/google-tokens.json` (localmente, `./data/google-tokens.json` por omissão).
5. `GOOGLE_CALENDAR_IDS` = lista de IDs de calendário separados por vírgula. Depois de autenticado, `/cals` lista os calendários disponíveis e os respetivos IDs.

### Studio Supabase (opcional)

Só usado pela cron de aniversários de clientes às 08:00. Sem `STUDIO_SUPABASE_URL`/`STUDIO_SUPABASE_KEY`, essa cron desliga-se sozinha (`studio_supabase.disabled` nos logs) — resto do bot funciona normalmente.

## 3. Correr localmente

```bash
npm run typecheck   # tsc --noEmit — confirma que o setup de TS está ok
npm run test        # vitest run — testes unitários, não tocam em Notion/Telegram reais
npm run build        # compila para dist/ + copia prompts .md
npm run dev          # node --watch dist/server.js — arranca o bot com as credenciais do .env
```

Se `npm run dev` arrancar sem erros, o bot está em long-polling e deve responder no grupo/DM configurados. Confirma nos logs (stdout, JSON estruturado):
- `bot.identified` — confirma o username do bot
- `server.crons_registered` — crons agendadas

## 4. Próximos passos

- Arquitetura completa: [`knowledge-base/bot-architecture.md`](knowledge-base/bot-architecture.md)
- Gotchas do Notion API: [`knowledge-base/notion-api-gotchas.md`](knowledge-base/notion-api-gotchas.md)
- Convenções do projeto (pt-PT, timezone, commits): secção "Project conventions" do [`README.md`](../README.md)
- Deploy real (NAS): [`runbook.md`](runbook.md) e [`knowledge-base/deploy-and-access.md`](knowledge-base/deploy-and-access.md)
