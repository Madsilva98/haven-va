# Deployment no NAS (Synology)

## Estrutura de ficheiros no NAS

```
/volume1/docker/haven-va/
├── data/
│   ├── .env               ← variáveis de ambiente (segredos)
│   └── google-tokens.json ← tokens Google Calendar (criado pelo /auth)
└── prompts/
    ├── multi-intent.md    ← prompt principal do extractor de intents
    └── extract-edit.md    ← prompt do editor de tarefas
```

## Primeiro deploy

### 1. Construir a imagem

A imagem é construída **localmente** (requer máquina com Docker) e depois carregada no NAS.

Na pasta do projecto:
```bash
npm run build                        # compila TS + copia .md para dist/
docker build -t haven-va-haven-va .  # constrói a imagem
docker save haven-va-haven-va -o haven-va.tar
```

Copia `haven-va.tar` para o NAS via File Station ou SCP, depois no NAS:
```bash
sudo docker load -i /volume1/docker/haven-va.tar
```

### 2. Criar as pastas persistentes

```bash
sudo mkdir -p /volume1/docker/haven-va/data
sudo mkdir -p /volume1/docker/haven-va/prompts
```

### 3. Copiar os prompts para o NAS

Copia via File Station (Windows → NAS):
- `dist/prompts/multi-intent.md` → `/volume1/docker/haven-va/prompts/`
- `dist/prompts/extract-edit.md` → `/volume1/docker/haven-va/prompts/`

### 4. Criar o .env

Copia `.env.example` para `/volume1/docker/haven-va/data/.env` e preenche todos os valores.

### 5. Iniciar o contentor

```bash
sudo docker run -d \
  --name haven-va-haven-va-1 \
  --restart unless-stopped \
  --env-file /volume1/docker/haven-va/data/.env \
  -e DATA_DIR=/data \
  -e TZ=Europe/Lisbon \
  -v /volume1/docker/haven-va/data:/data \
  -v /volume1/docker/haven-va/prompts:/app/dist/prompts \
  haven-va-haven-va
```

> O volume `-v .../prompts:/app/dist/prompts` é crítico — mantém os ficheiros de prompt
> fora da imagem para que sobrevivam a actualizações do contentor.

---

## Actualizar variáveis de ambiente

Edita `/volume1/docker/haven-va/data/.env` no NAS, depois **recria** o contentor
(simples `restart` não recarrega o env_file):

```bash
sudo docker stop haven-va-haven-va-1 && sudo docker rm haven-va-haven-va-1

sudo docker run -d \
  --name haven-va-haven-va-1 \
  --restart unless-stopped \
  --env-file /volume1/docker/haven-va/data/.env \
  -e DATA_DIR=/data \
  -e TZ=Europe/Lisbon \
  -v /volume1/docker/haven-va/data:/data \
  -v /volume1/docker/haven-va/prompts:/app/dist/prompts \
  haven-va-haven-va
```

---

## Actualizar o código

### Se só mudaram os prompts (.md)

Copia os ficheiros actualizados para `/volume1/docker/haven-va/prompts/` no NAS.
Não é necessário reiniciar — o ficheiro é lido a cada chamada à API.

> **Nota:** o conteúdo é cached em memória na primeira chamada. Para forçar
> a releitura, reinicia o contentor com o comando acima.

### Se mudou o código TypeScript

1. Localmente: `npm run build` + nova imagem Docker + `docker save`
2. No NAS: `sudo docker load -i haven-va.tar`
3. Recriar o contentor com o comando acima

---

## Comandos úteis no NAS

```bash
# Ver logs em tempo real
sudo docker logs haven-va-haven-va-1 -f

# Ver últimas 30 linhas
sudo docker logs haven-va-haven-va-1 --tail 30

# Ver estado do contentor
sudo docker ps

# Entrar no contentor (diagnóstico)
sudo docker exec -it haven-va-haven-va-1 sh
```

---

## Resolver o problema actual (prompts em falta)

Se o contentor não tiver os ficheiros de prompt (erro `ENOENT: no such file or directory`):

```bash
# Copia o ficheiro do NAS para dentro do contentor (fix temporário)
sudo docker cp /volume1/docker/haven-va/prompts/multi-intent.md haven-va-haven-va-1:/app/dist/prompts/multi-intent.md
sudo docker cp /volume1/docker/haven-va/prompts/extract-edit.md haven-va-haven-va-1:/app/dist/prompts/extract-edit.md
```

Para evitar este problema permanentemente, usa sempre o `-v .../prompts:/app/dist/prompts`
no `docker run` (ver acima).
