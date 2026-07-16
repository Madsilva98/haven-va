# 0001. grammY + long-polling em vez de webhook

## Estado
Aceite

## Contexto

O bot precisa de receber updates do Telegram. Duas abordagens padrão: **webhook** (Telegram faz POST para um endpoint HTTPS público quando há uma mensagem) ou **long-polling** (o bot pergunta ativamente ao Telegram "há novidades?" em loop).

O bot corre num único container Docker num Synology NAS em casa da Madalena, atrás de router doméstico, sem IP público nem reverse proxy com TLS configurado. Expor um endpoint HTTPS publicamente exigiria: domínio, certificado, port-forwarding no router doméstico (risco de segurança adicional numa máquina que também guarda `.env` com segredos), ou um túnel (Cloudflare Tunnel, ngrok) como dependência extra.

Volume de mensagens é baixo — 3 founders, uso esporádico ao longo do dia. Latência de long-polling (tipicamente sub-segundo com `getUpdates` em modo long-poll) é irrelevante a este volume.

Para o cliente Telegram em si, `grammY` foi escolhido por ser TypeScript-first, com tipos completos gerados da Bot API, e suporte nativo a long-polling sem infraestrutura adicional (`bot.start()`).

## Decisão

Usar `grammY` em modo long-polling (`bot.start()`), sem endpoint HTTP público. Nenhum webhook configurado — se um deploy anterior tiver deixado um webhook registado no Telegram, é preciso `deleteWebhook` explicitamente (ver `knowledge-base/deploy-and-access.md`, secção "Telegram webhook teardown").

## Consequências

- Sem necessidade de domínio, TLS, ou exposição de porta no router doméstico — reduz superfície de ataque numa máquina pessoal.
- Sem endpoint HTTP também significa sem healthcheck HTTP trivial — monitorização depende de ler logs do container (ver `runbook.md`).
- Se o processo de long-polling morrer sem crashar o container, não há alerta automático (`bot.start()` não tem handler de erro — ver `knowledge-base/failure-modes-2026-05-15.md`). Assumido conscientemente dado o baixo volume e a equipa pequena.
- Escala mal para múltiplas instâncias do bot (Telegram só permite um `getUpdates` ativo por token) — irrelevante ao caso de uso atual (single container).
