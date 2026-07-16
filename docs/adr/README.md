# Architecture Decision Records

Registo de decisões de arquitetura não-óbvias — o **porquê**, não o **como** (o como já está em `knowledge-base/bot-architecture.md` e no próprio código).

## Quando escrever um ADR

Quando tomares uma decisão técnica que:
- outra pessoa vai questionar daqui a 6 meses ("porque é que isto não usa X?"),
- tinha alternativas razoáveis e escolheste uma por um motivo concreto (não óbvio a partir do código),
- é cara de reverter depois de outras coisas dependerem dela.

Não escrevas ADR para decisões triviais ou reversíveis sem custo (nome de variável, escolha entre duas bibliotecas equivalentes sem trade-off real).

## Formato

Um ficheiro por decisão, numerado sequencialmente: `000N-titulo-curto.md`. Nunca editar o conteúdo de uma decisão já tomada — se a decisão mudar, cria um ADR novo e marca o antigo como `Substituído por 000X`.

```markdown
# 000N. Título curto da decisão

## Estado
Aceite | Proposto | Substituído por 000X

## Contexto
Que problema estava em cima da mesa. Que restrições existiam (equipa pequena,
custo, prazo, stack já escolhida). Que alternativas foram consideradas.

## Decisão
O que foi decidido, em 1-3 frases diretas.

## Consequências
O que isto implica — o que fica mais fácil, o que fica mais difícil, que
dívida técnica isto assume conscientemente.
```

## Índice

| ADR | Título | Estado |
|---|---|---|
| [0001](0001-grammy-long-polling.md) | grammY + long-polling em vez de webhook | Aceite |
| [0002](0002-docker-single-container.md) | Um único container Docker no NAS | Aceite |
| [0003](0003-notion-como-fonte-de-verdade.md) | Notion como única fonte de verdade, bot sem estado próprio | Aceite |
