# Haven VA — Guia rápido

Bot de Telegram que liga diretamente ao Notion e ao Google Calendar. Fala com ele como farias com uma colega — ele age, não pergunta.

---

## Como funciona

- Escreves em linguagem natural no grupo ou em DM
- O bot interpreta e age diretamente (cria tasks, regista decisões, etc.)
- Confirma sempre o que fez com uma mensagem de resposta
- Se errares o que disse, podes logo a seguir corrigir: *"afinal é da Mafalda"*, *"cancela"*, *"muda a prioridade para alta"*

**Não precisa de comandos especiais** para a maioria das coisas — basta escrever normalmente.

---

## O que podes pedir

### Tasks
| O que dizes | O que acontece |
|---|---|
| *"temos de contactar o ginásio X"* | Cria task no backlog |
| *"cria task para a Mafalda: preparar proposta"* | Task com owner definido |
| *"deadline sexta"* / *"para amanhã"* | Datas relativas funcionam |
| *"marca a task X como feita"* | Atualiza status |
| *"passa a task X para a Bia"* | Muda owner |
| *"cancela a task X"* | Status → Cancelado |
| *"prioridade alta na task X"* | Marca como alta + prioridade semanal automática |

### Projetos, Parceiros, Eventos, Influencers
| O que dizes | O que acontece |
|---|---|
| *"novo parceiro: Studio Yoga Lisboa"* | Cria página no Notion com secções |
| *"novo projeto: Método Haven Online"* | Cria projeto com estrutura |
| *"novo evento: Workshop Maio"* | Cria evento |
| *"novo influencer: @nome"* | Cria entrada |
| *"no projeto X escreve na secção Contexto: ..."* | Escreve na página do projeto |
| *"muda o status do parceiro X para Em negociação"* | Atualiza campo |

### Lembretes
| O que dizes | O que acontece |
|---|---|
| *"lembra-me amanhã às 10h de ligar ao X"* | Lembrete no Notion, bot avisa na hora |
| *"avisa a Mafalda sexta às 9h de enviar proposta"* | Lembrete para outra founder |
| *"lembra todas de reunião segunda às 9h"* | Lembrete para as três |
| *"lembra-me todos os dias às 8h de X"* | Lembrete diário — repete automaticamente |
| *"lembra-me toda a semana às 9h de X"* | Repete semanalmente no mesmo dia |
| *"lembra-me todo o mês às 9h de X"* | Repete mensalmente no mesmo dia |

### Google Calendar
| O que dizes | O que acontece |
|---|---|
| *"marca amanhã às 15h: reunião com parceiro X"* | Cria evento no calendário principal |
| *"adiciona ao calendário da receção: ..."* | Cria evento num calendário específico |

### Content Calendar (Social Media)
| O que dizes | O que acontece |
|---|---|
| *"ideia para post: benefícios do pilates"* | Adiciona ao Content Calendar |
| *"reel para sexta sobre a nova sala"* | Adiciona com data e tipo |
| *"muda o status do post X para Scheduled"* | Atualiza |

### Decisões & Discussões
| O que dizes | O que acontece |
|---|---|
| *"decidimos avançar com o projeto X"* | Regista em Decisions |
| *"precisamos discutir o preço das mensalidades"* | Adiciona a To Discuss |
| *"para a reunião: falar sobre parceria Y"* | Adiciona a To Discuss |

### Studio Log
| O que dizes | O que acontece |
|---|---|
| *"hoje tivemos reunião com a marca X"* | Regista no Studio Log |
| *"gravámos o primeiro reel"* | Regista com tag gravação |

---

## Comandos especiais (só DM com o bot)

| Comando | O que faz |
|---|---|
| `/hoje` | Lista as tuas tasks de hoje com semáforos de urgência |
| `/week` | Wizard para escolher as 3 prioridades da semana e definir foco operacional |
| `/dashboard` | Dashboard semanal — foco, prioridades e tópicos de discussão |
| `/projects` | Projetos em aberto em que és owner, com tasks associadas |
| `/partners` | Parceiros em que és owner, com tasks associadas |
| `/events` | Eventos em que és owner, com tasks associadas |
| `/influencers` | Influencers em que és owner, com tasks associadas |
| `/calendar` | Calendário Google — hoje e próximos 2 dias |
| `/content` | Content Calendar — conteúdo planeado nos próximos 3 dias |

---

## Estrutura do Notion

| Base de dados | Para quê |
|---|---|
| **Master Backlog** | Todas as tasks. Campos: Título, Owner, Área, Prioridade, Deadline, Status |
| **Projects** | Projetos com página própria (Contexto, Objetivos, Tasks, Decisões…) |
| **Partners** | Parceiros com pipeline de negociação |
| **Influencers** | Influencers com pipeline |
| **Events Pipeline** | Eventos com pipeline |
| **Content Calendar** | Posts/reels/stories com status de produção |
| **To Discuss** | Tópicos para a próxima reunião |
| **Decisions** | Decisões tomadas, com estado de implementação |
| **Studio Log** | Registo cronológico do que acontece no estúdio |
| **Reminders** | Lembretes do bot (não editar manualmente) |
| **Founder Focus** | Foco operacional semanal de cada founder |

---

## Campos do backlog

| Campo | Valores possíveis |
|---|---|
| Status | To do · Em curso · Bloqueado · Feito · Cancelado |
| Prioridade | 1. Alta · 2. Média · 3. Baixa |
| Owner | Madalena · Mafalda · Beatriz · Unassigned |
| Área | Marketing · Operações · Parcerias · Influencers · Tech · Cliente · Financeiro · Outro |

---

## Dicas

- **Não precisas de ser precisa no nome** — *"metodo haven"* encontra *"Método Haven"*, *"yoga studio"* encontra *"Yoga Studio Lisboa"*
- **Follow-ups funcionam** — depois de o bot criar algo, podes dizer *"afinal é urgente"* ou *"passa para a Bia"* sem repetir o nome
- **Fotos e ficheiros** — enviar uma imagem com caption no grupo anexa ao projeto/página mencionada no caption; imagens aparecem embutidas no Notion
- **Alta prioridade = prioridade semanal automática** — qualquer task marcada como 1. Alta fica automaticamente nas prioridades semanais
