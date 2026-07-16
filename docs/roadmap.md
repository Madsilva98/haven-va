# Roadmap

Lista de itens pendentes conhecidos. Adicionar entradas com data.

## Pendente

- **2026-07-16** — Configurar `STUDIO_SUPABASE_URL` (e restantes env vars do Supabase) no `.env` da NAS. Sem isto, a cron de aniversários de clientes (`src/crons/birthdays.ts`) fica desligada (`studio_supabase.disabled: STUDIO_SUPABASE_URL missing`).
- **2026-07-16** — Criar um README (o atual é genérico) e rever onde/como as coisas estão a ser gravadas — inclui rever o sistema de memory (`~/.claude/projects/.../memory/`).
