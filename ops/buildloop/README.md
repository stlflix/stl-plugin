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
