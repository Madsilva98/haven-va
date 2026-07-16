# Deployment no NAS (Synology)

## Estrutura de ficheiros no NAS

```
/volume1/docker/haven-va/
├── code/
│   └── haven-va/          ← git clone de Madsilva98/haven-va
│       ├── src/
│       └── dist/          ← construído por `npm run build` antes de cada build da imagem
└── data/                  ← montado como /data dentro do container
    ├── .env                ← variáveis de ambiente (segredos), NÃO em git
    └── google-tokens.json  ← token de refresh do Google Calendar, criado pelo /auth
```

Não há pasta separada de prompts no NAS — `src/prompts/*.md` é copiado para `dist/prompts/` por `scripts/copy-assets.mjs` durante `npm run build`, e o `Dockerfile` copia `dist/` inteiro para dentro da imagem. Os prompts ficam **dentro da imagem**, não montados como volume.

## Primeiro deploy

```bash
mkdir -p /volume1/docker/haven-va/code
cd /volume1/docker/haven-va/code
git clone https://github.com/Madsilva98/haven-va.git
cd haven-va

mkdir -p /volume1/docker/haven-va/data
cp .env.example /volume1/docker/haven-va/data/.env
# editar /volume1/docker/haven-va/data/.env e preencher tudo — ver docs/onboarding.md

npm install
npm run build

sudo docker compose build --no-cache
sudo docker compose up -d
```

## Atualizar (deploys seguintes)

```bash
cd /volume1/docker/haven-va/code/haven-va
git pull
npm run build
sudo docker compose build --no-cache
sudo docker compose up -d
```

### ⚠️ Nota crítica: `npm run build` tem de correr antes de `docker compose build`

O `Dockerfile` faz `COPY dist/ ./dist/` — **não** corre `npm run build` dentro da imagem. Se saltares o `npm run build` no NAS depois do `git pull`, a imagem nova leva o `dist/` antigo do disco, sem erro nenhum — o container sobe "saudável" a correr código desatualizado. Ver [`knowledge-base/failure-modes-2026-05-15.md`](knowledge-base/failure-modes-2026-05-15.md) ("Dockerfile gap").

Se mudaste só um prompt (`src/prompts/*.md`), também precisas do `npm run build` + rebuild — os prompts vão dentro da imagem, não há hot-reload.

## Atualizar variáveis de ambiente

Editar `/volume1/docker/haven-va/data/.env` e recriar o container — `docker compose restart` **não** relê o `env_file`:

```bash
sudo docker compose up -d --force-recreate
```

## Comandos úteis

```bash
sudo docker compose logs -f              # logs em tempo real
sudo docker compose logs --tail 30
sudo docker compose ps
sudo docker compose exec haven-va sh     # entrar no container (diagnóstico)
```

## Rollback

Ver [`knowledge-base/deploy-and-access.md`](knowledge-base/deploy-and-access.md#rollback) — `git checkout <sha> -- .` + rebuild (sem `image:` no compose, não há imagem antiga para reverter diretamente).

## Last touched

2026-07-16 — reescrito para refletir o fluxo real (`docker compose`). Removido o fluxo antigo `docker save`/`docker load` + volume manual de `/prompts` — obsoleto desde que `dist/prompts/` passou a ser copiado para dentro da imagem pelo `Dockerfile` em vez de montado por fora.
