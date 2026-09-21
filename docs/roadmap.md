# Roadmap

Lista de itens pendentes conhecidos. Adicionar entradas com data.

## Pendente

- **2026-07-16** — Criar um README (o atual é genérico) e rever onde/como as coisas estão a ser gravadas — inclui rever o sistema de memory (`~/.claude/projects/.../memory/`).
- **2026-09-16** — Rever o lote de 7 exemplos do classificador do tidy-mailboxes (`docs/knowledge-base/tidy-mailboxes-feedback-log.md`, entrada de 2026-09-14, estado `pending review`). Nada foi implementado a partir daí — precisa da tua leitura primeiro.
- **2026-09-16** — Incluir titulares de intro pack ativo (para além de mensalidade/credit pack) no digest de aniversários (`src/crons/birthdays.ts`). Ficou de fora porque não há forma fiável de ligar o `member_id` das views do Studio Supabase (`v_pulse_intro_holder_state`) ao `contact_email` do cliente — precisa de investigação extra do lado do Supabase antes de implementar.
- **2026-09-16** — Ligar WhatsApp/Instagram ao mecanismo de "Leads a contactar" (o código já está pronto para receber os dois canais, só falta o acesso). Bloqueado na verificação de negócio da Meta — a Madalena tentou entrar na App Meta existente (reutilizada de outro projeto) e não conseguiu. **Passa para a Mafalda tentar** (passos detalhados dados nesta sessão: verificar Business Verification, adicionar produtos WhatsApp/Instagram, ligar o número via Coexistence, ligar a conta de Instagram, pedir App Review para `instagram_business_manage_messages`).
- **2026-09-21** — Monitorização diária de Instagram de concorrência/inspiração (posts novos: produtos, promoções, aulas), a alimentar o mesmo Competitor Intel DB do `competitor-intel.ts`. Decisão da founder: fica só no roadmap por agora, nem sequer prototipar. Contexto para quando for retomado:
  - Conta descartável "Diana Maria" já criada num perfil Chrome separado (não é a conta pessoal nem a `@yourhavenpilates` real) — reduz o risco de a conta real do estúdio ser bloqueada pela deteção anti-bot do Instagram.
  - A técnica óbvia (chamar a API interna do Instagram — `api/v1/feed/user/{id}/` — via `fetch()` injetado com o header `X-IG-App-ID`, replicando a skill pública [browser-act instagram-profile-posts](https://github.com/browser-act/skills/tree/main/solutions/social-listening/instagram-profile-posts)) foi **bloqueada consistentemente pelo próprio filtro de segurança da extensão claude-in-chrome** (`[BLOCKED: Cookie/query string data]`), mesmo só a pedir o status da resposta. Não vale a pena tentar contornar — nem replicar a mesma técnica em código server-side, que seria a mesma ação por outra porta.
  - Sem essa técnica, resta scraping "normal" (navegar + ler o que está renderizado, como no backfill do Gmail) — precisa de um browser real (headless) a correr na NAS para automação não assistida, e a NAS já está com 1.4GB de swap em uso mesmo em idle (1.7GB RAM total, ~492MB "available") — risco real de não caber ou de degradar o bot em produção. Testar com cuidado antes de confiar nisto sem supervisão, se/quando for retomado.
  - `sessionid` do Instagram é `httpOnly` — não é legível via `document.cookie`; uma eventual automação server-side precisaria de um bootstrap ocasional (não diário) para obter a sessão, não de guardar a password da conta descartável diretamente (embora isso também seja uma opção aceitável dado ser uma conta descartável).

## Resolvido

- **2026-07-16 → 2026-09-15** — Configurar `STUDIO_SUPABASE_URL`/`STUDIO_SUPABASE_KEY` no `.env` da NAS. Feito, corrigido um crash de Node 20 que apareceu ao ativar (WebSocket transport), reconfirmado a funcionar em produção.
