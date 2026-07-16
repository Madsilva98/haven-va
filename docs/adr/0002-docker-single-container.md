# 0002. Um único container Docker no NAS

## Estado
Aceite

## Contexto

O bot tem várias responsabilidades concorrentes: routing de mensagens Telegram (long-polling contínuo), 6 crons agendadas (`src/crons/`), chamadas a APIs externas (Notion, Anthropic, Google Calendar, Supabase). Todas correm no mesmo processo Node hoje.

A infraestrutura disponível é um único Synology NAS doméstico — sem Kubernetes, sem orquestração multi-serviço, sem load balancer. `docker compose` com `build: .` (sem `image:`) é o mecanismo de deploy.

Dividir em serviços separados (ex.: um processo para o bot Telegram, outro para as crons, outro para um eventual endpoint HTTP) traria isolamento de falhas — uma cron lenta não bloquearia o handler de mensagens — mas exigiria: múltiplos containers, rede interna entre eles, e coordenação de estado partilhado (cache de open-tasks, dedupe de updates) que hoje vive em memória de processo único.

## Decisão

Um único processo Node (`src/server.ts`) regista as crons via `node-cron` **e** arranca o bot grammY em long-polling, no mesmo container Docker. Sem filas, sem processos separados, sem estado partilhado entre processos.

## Consequências

- Deploy simples: `docker compose build && docker compose up -d`, um único artefacto.
- Estado em memória (cache de tarefas abertas, dedupe de updates, mapas de wizard) é trivial de implementar — não há sincronização entre processos a considerar. Ver `knowledge-base/bot-architecture.md`, secção "State model".
- Uma cron lenta ou presa (ex.: chamada Notion sem timeout) pode atrasar o processamento de mensagens Telegram, porque partilham o event loop. Aceitável ao volume atual (3 founders, baixo tráfego).
- Um crash do processo (ex.: exceção não apanhada) derruba simultaneamente o bot e todas as crons — não há isolamento de falha entre responsabilidades.
- Reinício do container perde todo o estado em memória (cache, dedupe, wizards em curso) — assumido porque a fonte de verdade real é sempre o Notion, nunca o processo (ver ADR 0003).
