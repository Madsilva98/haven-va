# Testing

Duas camadas distintas, com propósitos diferentes — não se substituem uma à outra.

## Camada 1 — `test/*.test.ts` (vitest, unitário)

Corre com `npm run test` (single pass) ou `npm run test:watch`. **Não toca em Notion, Telegram ou Anthropic reais** — testa lógica pura isolada.

Cobertura atual (4 ficheiros, 57 testes):

| Ficheiro | Cobre |
|---|---|
| `test/recurrence.test.ts` | `src/lib/recurrence.ts` — cálculo de próximas ocorrências de lembretes recorrentes |
| `test/data-source-resolver.test.ts` | Resolução de `data_source_id` a partir de `database_id` (migração da API Notion 2025-09-03) — inclui o "canário" que deteta uma base com múltiplos data sources |
| `test/content-calendar-scheduling.test.ts` | Lógica de agendamento do calendário de conteúdo |
| `test/birthdays.test.ts` | Lógica da cron de aniversários de clientes (Studio Supabase) |

**O que esta camada explicitamente não cobre**: routing do bot (`src/bot/index.ts`), o loop de tool-use do assistente (`src/bot/assistant.ts`), nenhuma chamada real a Notion/Telegram/Anthropic. É lógica de negócio pura, com inputs/outputs determinísticos — datas, regras de agendamento, resolução de IDs.

**Convenção**: um ficheiro `test/<tópico>.test.ts` por área lógica, importa direto de `../src/...`. Ver `test/recurrence.test.ts` como exemplo do estilo (describe/it, sem mocks pesados — a lógica testada não tem I/O).

## Camada 2 — `scripts/test-*.mjs` (integração manual, contra sistemas reais)

Não correm em CI nem em `npm run test` — são scripts standalone, corridos manualmente contra credenciais reais (`.env.local`), tipicamente antes de um deploy que toca em código sensível (migração de API, mudança no prompt do assistente).

| Script | O que faz | Escreve em produção? |
|---|---|---|
| `scripts/test-data-sources-migration.mjs` | Chama todos os caminhos de leitura do `notion.ts` e confirma que não rebentam | Não — só leitura, seguro contra dados reais |
| `scripts/test-data-sources-writes.mjs` | Exercita todos os caminhos de escrita (`data_source_id`), cria entradas prefixadas `[MIGRATION TEST]`, arquiva no fim | Sim, mas limpa a seguir |
| `scripts/test-data-sources-e2e.mjs` | Simula mensagens Telegram reais através do pipeline completo (Haiku → `notion.ts`), entradas prefixadas `[E2E MIGRATION TEST]` | Sim (Notion + custo real de Anthropic, ~$0.005/mensagem), limpa no fim |
| `scripts/test-prompt-behavior.mjs` | Para cada mensagem de teste, confirma que o Haiku chamou a tool certa (e não chamou as erradas) | Sim, limpa via `archivePage` no fim |

Cada script tem um cabeçalho `/** Usage: ... */` com o comando exato. Padrão comum:

```bash
# Uma vez: copiar as env vars reais do NAS
cp /volume1/docker/haven-va/data/.env .env.local   # via File Station/SCP, não commitar

npm run build
node --env-file=.env.local scripts/test-data-sources-migration.mjs
```

**Quando correr qual**: `test-data-sources-migration.mjs` é seguro correr a qualquer momento (só leitura). Os outros três criam e apagam dados reais — corre-os antes de um deploy que muda `notion.ts` ou `src/prompts/assistant.md`, não como rotina diária.

## Porque não estão fundidos numa coisa só

A camada 1 precisa de ser rápida e determinística para correr em cada `npm run test` sem custo nem dependência de rede. A camada 2 existe precisamente para o oposto — validar contra o sistema real, incluindo custo de API e comportamento do modelo, que não é determinístico. Misturar as duas faria a suite unitária lenta, cara, e flaky.

## Como adicionar um teste

- **Lógica nova e pura** (parsing, cálculo de datas, ranking) → `test/<tópico>.test.ts`, vitest.
- **Mudança num write path do `notion.ts`** → estende `scripts/test-data-sources-writes.mjs` com o novo caso, seguindo o padrão de prefixo + archive no fim.
- **Mudança no prompt do assistente ou nas tools** → adiciona um caso a `scripts/test-prompt-behavior.mjs` com a mensagem de teste e a tool esperada.

## Last touched

2026-07-16 — criado durante a sessão de reorganização de documentação.
