# Roadmap

Lista de itens pendentes conhecidos. Adicionar entradas com data.

## Pendente

- **2026-07-16** — Criar um README (o atual é genérico) e rever onde/como as coisas estão a ser gravadas — inclui rever o sistema de memory (`~/.claude/projects/.../memory/`).
- **2026-09-16** — Rever o lote de 7 exemplos do classificador do tidy-mailboxes (`docs/knowledge-base/tidy-mailboxes-feedback-log.md`, entrada de 2026-09-14, estado `pending review`). Nada foi implementado a partir daí — precisa da tua leitura primeiro.
- **2026-09-16** — Incluir titulares de intro pack ativo (para além de mensalidade/credit pack) no digest de aniversários (`src/crons/birthdays.ts`). Ficou de fora porque não há forma fiável de ligar o `member_id` das views do Studio Supabase (`v_pulse_intro_holder_state`) ao `contact_email` do cliente — precisa de investigação extra do lado do Supabase antes de implementar.
- **2026-09-16** — Ligar WhatsApp/Instagram ao mecanismo de "Leads a contactar" (o código já está pronto para receber os dois canais, só falta o acesso). Bloqueado na verificação de negócio da Meta — a Madalena tentou entrar na App Meta existente (reutilizada de outro projeto) e não conseguiu. **Passa para a Mafalda tentar** (passos detalhados dados nesta sessão: verificar Business Verification, adicionar produtos WhatsApp/Instagram, ligar o número via Coexistence, ligar a conta de Instagram, pedir App Review para `instagram_business_manage_messages`).

## Resolvido

- **2026-07-16 → 2026-09-15** — Configurar `STUDIO_SUPABASE_URL`/`STUDIO_SUPABASE_KEY` no `.env` da NAS. Feito, corrigido um crash de Node 20 que apareceu ao ativar (WebSocket transport), reconfirmado a funcionar em produção.
