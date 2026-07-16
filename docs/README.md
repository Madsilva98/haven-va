# Documentação — haven-va

Ponto de entrada único para toda a documentação do projeto. Se procuras algo e não sabes onde está, começa aqui.

## Onboarding

| Doc | Para quê |
|---|---|
| [`onboarding.md`](onboarding.md) | Checklist "dia 1" — clonar, correr localmente, credenciais Telegram/Notion/Google |
| [`guia-haven-va.md`](guia-haven-va.md) | Guia de utilização para as founders (não-técnico) — como falar com o bot |

## Arquitetura e decisões

| Doc | Para quê |
|---|---|
| [`knowledge-base/bot-architecture.md`](knowledge-base/bot-architecture.md) | Modelo mental em 10 minutos — fluxo de mensagens, mapa de ficheiros, crons, estado |
| [`adr/`](adr/) | Registo de decisões de arquitetura (porquês, não comos) |

## Operações

| Doc | Para quê |
|---|---|
| [`runbook.md`](runbook.md) | **O bot está avariado — o que faço?** Cenários de incidente e resposta |
| [`nas-deploy.md`](nas-deploy.md) | Runbook de deploy passo-a-passo no NAS (`docker compose build && up -d`) |
| [`knowledge-base/deploy-and-access.md`](knowledge-base/deploy-and-access.md) | Acesso ao NAS (Tailscale, DSM, Container Manager), rollback, higiene de segredos |
| [`nas-ssh-setup.md`](nas-ssh-setup.md) | Registo (datado) de como foi configurado o acesso SSH da Mafalda |

## Referência técnica

| Doc | Para quê |
|---|---|
| [`knowledge-base/notion-api-gotchas.md`](knowledge-base/notion-api-gotchas.md) | Modelo de dados Notion, quirks de propriedades, rate limits, retry |
| [`knowledge-base/testing.md`](knowledge-base/testing.md) | O que é testado (vitest) vs. o que é verificado manualmente (`scripts/test-*.mjs`) |
| [`notion-db-config.xlsx`](notion-db-config.xlsx) | Configuração das bases de dados Notion — gerado por `scripts/gen-notion-config.mjs`, não editar à mão |

## Histórico (snapshots datados)

| Doc | Para quê |
|---|---|
| [`knowledge-base/failure-modes-2026-05-15.md`](knowledge-base/failure-modes-2026-05-15.md) | Catálogo de modos de falha, ponto no tempo — congelado, não editar |
| [`knowledge-base/cost-and-latency-2026-05-15.md`](knowledge-base/cost-and-latency-2026-05-15.md) | Baseline de custo/latência Anthropic + Notion — congelado, não editar |
| [`roadmap.md`](roadmap.md) | Itens pendentes conhecidos, com data |

## Convenções desta pasta

- **`docs/knowledge-base/`** — documentação viva sobre "como o bot funciona e onde parte" (ver [o seu próprio índice](knowledge-base/README.md) para a lógica de datados-vs-vivos).
- **`docs/adr/`** — decisões de arquitetura já tomadas, uma por ficheiro, nunca reescritas (só o estado pode mudar: proposta → aceite → substituída).
- **Resto de `docs/`** — guias operacionais e de utilização que não são "conhecimento sobre o código" mas sim "como usar/operar o produto".
- Se criares um ficheiro novo em `docs/` ou `docs/knowledge-base/`, adiciona-o a esta tabela — evita o problema de "descoberta às cegas".
