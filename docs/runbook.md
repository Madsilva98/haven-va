# Runbook de incidentes

"O bot está avariado, o que faço agora." Distinto de [`nas-deploy.md`](nas-deploy.md) (como fazer deploy) e [`knowledge-base/deploy-and-access.md`](knowledge-base/deploy-and-access.md) (como chegar ao NAS, rollback) — este doc foca-se em diagnóstico e resposta a sintomas em produção.

Antes de mais: [`knowledge-base/deploy-and-access.md`](knowledge-base/deploy-and-access.md) tem a lista completa de termos de log úteis para procurar no Container Manager. Este runbook assume que já sabes lá chegar.

## O bot não responde a nenhuma mensagem

1. Container Manager → confirma que `haven-va-haven-va-1` está **Running** (não "Exited" nem em loop de restart — ver secção abaixo se estiver).
2. Procura `bot.started` nos logs — deve aparecer uma vez no arranque. Se não aparecer, o long-polling nunca arrancou (ver `bot.getMe_failed` — token inválido é a causa mais comum).
3. Se o container está saudável mas o bot não responde: o processo de long-polling pode ter morrido sem crashar o container (`bot.start()` não tem handler de erro — ver `knowledge-base/failure-modes-2026-05-15.md`, secção Low). **Fix imediato**: `docker compose restart` (ou recriar). Não há healthcheck automático hoje — isto é conhecido, não é surpresa.
4. Confirma que o founder que está a testar tem o Telegram ID certo em `.env` (`TELEGRAM_*_ID`). IDs errados fazem o bot ignorar em silêncio — sem erro nenhum nos logs.

## O bot responde mas "erro — tenta outra vez" em tudo

1. Procura `notion.error` ou `error` nos logs à volta da hora do sintoma.
2. **`validation_error` com nome de propriedade no erro** → alguém renomeou uma coluna no Notion. `src/notion.ts` tem os nomes de propriedade hardcoded em português (`"Título"`, `"Área"`, etc.) — ver `knowledge-base/notion-api-gotchas.md`. Fix: reverter o nome no Notion, ou atualizar o código para o nome novo (mudança deliberada, não patch de urgência).
3. **429 persistente** → rate limit do Notion. `withRetry` já tenta 3x (0.5/2/8s); se mesmo assim falha, o volume de escrita está a exceder o limite da integração. Não há fix imediato além de esperar — investigar se algo está a escrever em loop (ver "container reinicia em loop" abaixo, ou cron duplicado).
4. **5xx do lado do Notion** → normalmente transitório, `withRetry` absorve. Se persistir >5 min, é outage do lado do Notion — confirma em [status.notion.so](https://status.notion.so).

## Lembretes a duplicar ou a chegar à hora errada

Problema conhecido de timezone — ver `knowledge-base/failure-modes-2026-05-15.md`, secção Critical (`src/lib/tz.ts`, `nextOccurrence`, `lisbonLocalToUtc`). Todo o cálculo de data/hora assume `TZ=Europe/Lisbon` no container; se essa env var alguma vez faltar ou mudar, os lembretes desviam-se silenciosamente. **Primeiro passo de diagnóstico**: confirma `TZ=Europe/Lisbon` no `.env` do NAS antes de tocar em código.

Lembrete a repetir-se duas vezes na mesma janela de 5 min → falta de mutex na cron (`src/crons/reminders.ts`, ver failure-modes). Não há fix automático hoje; se acontecer, é esperado sob Notion lento — não é bug novo.

## Mensagem rejeitada pelo Telegram (brief semanal/dashboard não chega)

Duas causas conhecidas (`knowledge-base/failure-modes-2026-05-15.md`, secção High):
- **Texto >4096 caracteres** — Telegram rejeita com HTTP 400. As crons semanais (`weekend-brief`, `friday-balance`, `monday-priorities`) constroem mensagens a partir de resultados Notion sem limite superior; se o backlog crescer muito, isto pode acontecer.
- **Caracteres MarkdownV2 não escapados** — título ou texto de foco com `(`, `)`, `.`, `-`, `!`, `+`, `=` que não passou por `escapeMd` (`src/messages/cycle.ts`) faz o Telegram rejeitar a mensagem inteira.

Diagnóstico: procura `error` nos logs perto da hora agendada da cron em causa.

## Container reinicia em loop

1. `docker compose logs --tail 100` (ou Container Manager → Log) para a razão do crash.
2. Confirma que `dist/` no NAS está atualizado — o `Dockerfile` copia `dist/` do host, não corre `npm run build` dentro da imagem (gap conhecido, ver `knowledge-base/failure-modes-2026-05-15.md`, "Worth following up"). `dist/` desatualizado normalmente não crasha, mas se uma dependência nova não foi instalada (`node_modules` do host stale), pode.
3. Confirma `.env` tem `NOTION_BACKLOG_DB_ID` preenchido — é a única variável verdadeiramente obrigatória; falta dela impede o arranque.

## Token comprometido (leak, screenshot, etc.)

Segue a secção **"Secret hygiene"** em [`knowledge-base/deploy-and-access.md`](knowledge-base/deploy-and-access.md#secret-hygiene) — tem os passos de rotação para Notion, Telegram, Anthropic e Google Calendar. Não duplicado aqui para evitar as duas versões divergirem.

## Calendário Google parou de funcionar

- `calendar.token_revoked` ou erro genérico de fetch nos logs → o refresh token do Google expirou ou foi revogado. Fix: repetir o fluxo `/auth` (ver [`onboarding.md`](onboarding.md#google-calendar-opcional)) como Madalena.
- Confirma que `DATA_DIR` está montado como volume persistente no `docker-compose.yml` — se não estiver, `google-tokens.json` perde-se em cada rebuild (`docker compose build --no-cache`).

## Não sei o que se passa

`knowledge-base/failure-modes-2026-05-15.md` é o catálogo mais completo de coisas que **podem** partir (nem tudo lá é um incidente ativo — é uma lista de riscos conhecidos do código). Se o sintoma não está neste runbook, procura lá primeiro antes de investigar do zero.
