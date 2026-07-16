# 0003. Notion como única fonte de verdade, bot sem estado próprio

## Estado
Aceite

## Contexto

O bot precisa de "lembrar-se" de tarefas, lembretes, foco semanal, decisões, pipelines de parceiros/influencers, etc. As founders já usavam Notion antes do bot existir — é onde trabalham diariamente e onde esperam ver/editar os dados manualmente quando quiserem, sem passar pelo bot.

Uma base de dados própria (SQLite local, Postgres gerido) daria mais controlo de schema e queries mais rápidas, mas criaria dois lugares onde a mesma informação pode viver e divergir — e obrigaria as founders a confiar exclusivamente no bot para ver o estado, perdendo a edição manual direta no Notion a que já estão habituadas.

## Decisão

Notion é a única fonte de verdade para todos os dados persistentes de negócio (tarefas, lembretes, foco, decisões, pipelines). O bot não mantém base de dados própria. Todo o estado em memória do processo (`src/notion.ts` — cache de open-tasks 60s, `bot/history.ts`, mapas de wizard) é **cache ou conveniência de sessão**, nunca a única cópia de um dado — tudo reconstrói a partir do Notion no arranque seguinte ou na próxima leitura. Ver `knowledge-base/bot-architecture.md`, secção "State model", para a lista completa do que é efémero.

## Consequências

- Founders podem sempre editar diretamente no Notion — o bot não é um gatekeeper obrigatório.
- `docker restart` a qualquer momento é seguro — nada de negócio se perde, só cache/sessão.
- Toda a leitura passa pela API do Notion — latência e rate limits do Notion tornam-se latência e rate limits do bot (mitigado com cache de 60s em `getOpenTasks`, ver `notion.ts`).
- Brittleness de schema: nomes de propriedades Notion estão hardcoded em `src/notion.ts` em português (`"Título"`, `"Área"`, etc.). Renomear uma coluna no Notion UI parte o bot silenciosamente até alguém atualizar o código — trade-off aceite explicitamente por não haver camada de mapeamento configurável hoje (ver `knowledge-base/notion-api-gotchas.md` e `knowledge-base/failure-modes-2026-05-15.md`, secção Critical).
- Sem transações multi-tabela — uma operação que escreve em duas bases Notion (ex.: task + relação a entidade) pode falhar a meio, deixando estado parcialmente escrito. Mitigado caso a caso com `withRetry`, não com rollback.
