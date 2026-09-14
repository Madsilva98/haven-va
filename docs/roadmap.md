# Roadmap

Lista de itens pendentes conhecidos. Adicionar entradas com data.

## Pendente

- **2026-07-16** — Configurar `STUDIO_SUPABASE_URL` (e restantes env vars do Supabase) no `.env` da NAS. Sem isto, a cron de aniversários de clientes (`src/crons/birthdays.ts`) fica desligada (`studio_supabase.disabled: STUDIO_SUPABASE_URL missing`).
- **2026-07-16** — Criar um README (o atual é genérico) e rever onde/como as coisas estão a ser gravadas — inclui rever o sistema de memory (`~/.claude/projects/.../memory/`).
- **2026-09-14** — Base de dados de leads a partir de DMs de WhatsApp/Instagram (só leitura, novas mensagens a partir de agora). Bloqueado em Business Verification + App Review da Meta (Phase 0) antes de qualquer código. Plano completo em [`docs/plans/leads-whatsapp-instagram.md`](plans/leads-whatsapp-instagram.md).
