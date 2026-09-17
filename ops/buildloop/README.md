# Stack BuildLoop no `mkt-vps` — runbook

O *porquê* está em `../../docs/decisions/005-…`, `006-…`, `008-…` e `009-…`.
Isto é o *como*.

- **Host**: `ubuntu@166.0.186.190` (`mkt-vps`), chave `~/.ssh/id_ed25519_stlflix_vps`
- **Diretório**: `/home/ubuntu/buildloop/` — este compose, o `.env`, e as cópias
  de `mcp-server/` e `functions-runtime/` que viram as duas imagens
- **Superfícies**: `https://<BUILDLOOP_HOST>/mcp` (MCP, bearer) ·
  `https://<BUILDLOOP_HOST>/fn/<slug>/<nome>` e `/auth/jwks` (runtime) · loopback
  `5433` (Postgres) e `8200` (MCP) por túnel SSH · `/admin` **não é roteado**

Três containers, 1,4 GB de `mem_limit` somados. Postgres oficial: nenhuma
imagem de fornecedor, nenhum serviço que não usamos.

## Pré-condição de DNS — leia antes de subir

`BUILDLOOP_HOST` **tem de estar na zona `stlflix.com`, ou com o proxy da
Cloudflare desligado (DNS-only)**. Não é preferência: a zona `.com.br` tem
*Cache Everything* na zona inteira (medido em 2026-09-11), e `/fn/<slug>/<nome>`
responde **GET 200 com conteúdo autenticado do colaborador**. Numa zona que
cacheia, a resposta de um usuário logado é servida ao anônimo seguinte — o mesmo
vazamento do
[AD-028 da plataforma](https://github.com/stlflix/plataforma-product-ops/blob/main/docs/decisions/028-toda-resposta-autenticada-de-api-entra-no-edge.md).

O `Cache-Control: private, no-store` que o runtime envia é correto e **não
fecha isso**: a chave de cache da zona não varia com o header. O que fecha é a
zona.

**Dois hosts enquanto o DNS não existe.** `BUILDLOOP_HOST` serve só `/mcp` (POST,
não cacheia) e pode ficar em `db.stlflix.com.br`, como hoje. `BUILDLOOP_FN_HOST`
(opcional, padrão = `BUILDLOOP_HOST`) é o host de `/fn/` e `/auth/`: aponte-o para
`db.stlflix.com` e crie o registro na zona `.com` quando for a hora — até lá as
Edge Functions ficam inalcançáveis de fora, que é o comportamento seguro.

Enquanto o registro não existir, o acesso é por túnel SSH (`8200` MCP, `8300`
runtime, `5433` Postgres):

```bash
ssh -N -L 8200:127.0.0.1:8200 -L 5433:127.0.0.1:5433 mkt-vps
```

## Subir do zero

```bash
mkdir -p /home/ubuntu/buildloop && cd /home/ubuntu/buildloop
python3 gen-env.py .                 # 7 chaves, chmod 600, recusa sobrescrever
rsync -a --delete --exclude node_modules ~/Projetos/stl-plugin/mcp-server/        mcp-src/
rsync -a --delete --exclude node_modules ~/Projetos/stl-plugin/functions-runtime/ fn-src/
docker build -t stl-buildloop-mcp:0.4.0       mcp-src
docker build -t stl-buildloop-functions:0.1.0 fn-src
docker compose up -d
```

Depois, **uma vez**: copie o `AUTH_PRIVATE_KEY` do `.env` para o
`productops-web` como `BUILDLOOP_AUTH_PRIVATE_KEY`. É a única chave que assina
identidade e ela mora só lá (I6) — esta stack fica com a metade pública.

O `.env` **não é regenerável**: um `gen-env.py` novo trocaria o
`POSTGRES_PASSWORD` sob um banco vivo e a `MCP_CREDENTIALS_KEY` sob as senhas
cifradas de todos os colaboradores. Por isso ele recusa sobrescrever.

## Atualizar uma imagem

```bash
rsync -a --delete --exclude node_modules ~/Projetos/stl-plugin/mcp-server/ mkt-vps:/home/ubuntu/buildloop/mcp-src/
ssh mkt-vps 'cd /home/ubuntu/buildloop \
  && docker build -t stl-buildloop-mcp:<tag> mcp-src \
  && sed -i "s/^MCP_IMAGE_TAG=.*/MCP_IMAGE_TAG=<tag>/" .env \
  && docker compose up -d mcp'
```

O runtime é igual, com `fn-src`, `stl-buildloop-functions` e
`FUNCTIONS_IMAGE_TAG`. Se a variável não estiver no `.env`, o compose usa o
padrão que está escrito nele (`0.4.0` / `0.1.0`).

## Backfill do grant de chave de secret (AD-010)

Banco provisionado antes do AD-010 nao tem o `GRANT SELECT (name, key)` em
`buildloop.edge_function_secrets`, e sem ele `edge.list` responde 502 para o
colaborador. Depois de subir a imagem nova do MCP, uma vez:

```bash
ssh mkt-vps 'docker exec buildloop-mcp node scripts/grant-secret-keys.mjs'
```

Ele le os slugs do registro, aplica o revoke + grant em cada `db_<slug>`,
imprime uma linha por slug e sai 1 se algum falhar. E idempotente.

## Colaborador novo

Pela plataforma (módulo **BuildLoop**) — é ela que chama a API admin do MCP. Na
mão, do host: ver `../../mcp-server/README.md`.

## Migração da stack antiga

`scripts/migrate-from-supabase.sh` — ele confere a contagem de linhas dos dois
lados **antes** de qualquer troca, e aborta se divergir (BL-08).

## Verificar sem subir nada

```bash
docker compose -f docker-compose.yml config >/dev/null   # valida offline, sem daemon
```

## Cutover executado — 2026-09-16

Checklist do T49 da feature `buildloop-studio`, como saiu na hora:

- **Ok do Lucas** na sessão para o cutover e o deploy; dados do cluster antigo eram
  de teste, então **não houve migração**: cluster novo do zero, `compare-counts`
  não se aplica. Volumes do Supabase preservados (`docker volume ls | grep supabase`),
  para remover à mão depois de 7 dias; `/home/ubuntu/supabase-ops/` ficou no disco.
- Imagens construídas no host: `stl-buildloop-mcp:0.4.0` (339 MB) e
  `stl-buildloop-functions:0.1.0` (245 MB), a partir da `main` do `stl-plugin`.
- `gen-env.py` gerou o `.env`; `MCP_ADMIN_KEY` foi trocada pela chave que a
  plataforma já usava; `BUILDLOOP_HOST=db.stlflix.com.br` (só `/mcp`) e
  `BUILDLOOP_FN_HOST=db.stlflix.com` — registro A criado pelo Lucas na zona `.com`
  (proxied) em 2026-09-16, ~19:50 UTC; testado pela Cloudflare: `/auth/jwks` 200
  `cf-cache-status: DYNAMIC` em três hits, `/fn/<slug>/<fn>` 404/400 com
  `private, no-store`, `/mcp` e `/healthz` 404 nesse host, HTTP→HTTPS 301. `AUTH_PRIVATE_KEY` copiada para o `productops-web` como
  `BUILDLOOP_AUTH_PRIVATE_KEY` (a que estava lá não era uma chave ES256).
- `docker compose down` da stack `supabase` (7 containers) e `docker image rm`
  de `supabase/*`, `postgrest/*`, `envoyproxy/envoy` e `stl-supabase-mcp`.
- `docker compose up -d`: `buildloop-db` healthy, `/healthz` do MCP
  `{"ok":true,"collaborators":0}`, `/healthz` do runtime `{"ok":true}`,
  `/auth/jwks` devolve `EC P-256`. `docker ps`: `postgres:16`,
  `stl-buildloop-mcp:0.4.0`, `stl-buildloop-functions:0.1.0`; zero `supabase/*`.
- Público: `https://db.stlflix.com.br/mcp` → GET 405, POST 401 (o MCP novo);
  `/auth/jwks` no host `.com.br` → 404 (não roteado, de propósito).
- Plataforma: `.env` do `productops-web` reescrito (`BUILDLOOP_*`, backup
  `.env.bak-20260916-191728`), imagem `sha-850ce51` (build-image.yml, run
  35139458838) deployada por `deploy/deploy.sh`, healthy; `/api/buildloop/auth/exchange`
  POST → 401 `{"success":false}` (chave privada carregou), GET → 405.
- Colaboradores: o registro `stl_mcp` nasceu vazio — cada um recria o banco e o
  token pelo módulo BuildLoop; a URL do MCP não mudou.
