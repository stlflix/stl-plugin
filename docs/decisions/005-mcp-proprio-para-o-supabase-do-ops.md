# 005 — O colaborador alcança o Supabase self-hosted por um MCP nosso

**Status:** aceito · **Data:** 2026-09-10 · **Substitui:** [002](002-supabase-self-hosted-sem-mcp.md)

## Contexto
O AD-002 recusou qualquer MCP de Supabase porque os disponíveis cobravam um preço
que o colaborador não deveria pagar: o Postgres MCP guarda a connection string no
Keychain dele, e o PostgREST MCP expõe a `service_role` — chave com poder total —
a cada sessão. A saída era a CLI `supabase` com o `.env` do projeto.

O próprio AD-002 previa o fim disso: *"quando o self-hosted ganhar um servidor MCP
com OAuth próprio, esta decisão é substituída"*. O Lucas pediu acesso por MCP **e**
por web, com o colaborador vendo o próprio banco com o próprio login.

## Decisão
Um servidor MCP **nosso** (`mcp-server/`), no ambiente ops, na frente de **uma**
stack Supabase self-hosted onde cada colaborador tem **um banco**.

- **Transporte** HTTP streamable, *stateless*: um servidor e um transporte por
  requisição, então nenhuma sessão vaza de um colaborador para o outro.
- **Auth** `Authorization: Bearer <token>`. Só o sha256 do token vai para o disco
  (`tokens.json`) — o arquivo não é uma lista de credenciais.
- **Isolamento é do Postgres, não do nosso código.** Cada consulta abre conexão com
  a **role do próprio colaborador**, nunca `postgres` nem `service_role`. Um bug no
  servidor continua sem alcançar o banco de outro: o Postgres recusa a conexão.
- **A connection string nunca sai do servidor** — que era exatamente a objeção do
  AD-002.
- Tools: `list_tables`, `describe_table`, `run_sql`, `apply_migration`,
  `list_migrations`.

## O que foi medido (2026-09-10, `mkt-vps`)
- A stack roda **enxuta: 6 serviços** (`db`, `meta`, `rest`, `auth`, `studio`,
  `api-gw`) + o nosso `mcp`. Custo real **621 MB**, não os ~1,1 GB dos 11 serviços.
  O host tem 8 GB, **sem swap nenhum**, dividindo com `productops-web`, o n8n-ops
  (3,06 GB) e o `whisper-api`. Todo container ganhou `mem_limit`, a convenção que
  as outras stacks da máquina já seguiam.
- `realtime`, `storage`, `imgproxy`, `functions` e `supavisor` ficaram **de fora**,
  reversível com `docker compose up -d <serviço>`.
- **O `postgres` da imagem do Supabase não é superusuário.** `CREATE DATABASE ...
  OWNER <role>` falha com *"must be able to SET ROLE"*; o provisionamento roda como
  `supabase_admin`.
- **O `PUBLIC` do Postgres dá `CONNECT` por padrão.** Sem revogar, o colaborador
  alcançava o banco compartilhado `postgres` (onde vivem `auth.users` e o storage),
  o `template1` e o `_supabase`. `harden-shared-db.sh` fecha isso e o
  `provision-collaborator.sh` já nasce fechado, via o grupo `stl_collaborator`.
- **`COMPOSE_FILE` no `.env` desliga o override automático.** Enquanto ele valia
  `docker-compose.yml`, o `docker-compose.override.yml` era silenciosamente ignorado
  — os `mem_limit` e o bind em loopback não existiam e nada avisava.
- Portas: o gateway usa **8100**, porque o `whisper-api` já ocupa o `127.0.0.1:8000`.

## Consequências
- O `.mcp.json` do plugin ganha o servidor `supabase`, com o token em `userConfig`
  (Keychain). O `stl-setup` passa a emitir o token, não a connection string.
- `supabase db push` da máquina do colaborador **não alcança** o banco sem túnel
  SSH: o Postgres só escuta em loopback. O caminho suportado é `apply_migration`
  pelo MCP; a CLI continua valendo para quem tem acesso ao host.
- O `security-check` continua tratando `postgres://user:pass@` e `service_role` no
  diff como BLOCK — agora com menos motivo para aparecerem.
- **Studio é por banco** (`POSTGRES_DB` + `meta`) e o login do dashboard é um par
  único no envoy. Web por colaborador, com login próprio, exige um satélite
  `meta`+`studio` por pessoa (~360 MB cada) — decidido quando houver o segundo
  colaborador de verdade.
- **A rota é a da plataforma, não um subdomínio novo**: `ops.stlflix.com.br/mcp`,
  como sub-rota de `productops-web`, na mesma forma que `content-assets` e
  `rastreio-api` já usam nesta máquina — `Host(...) && PathPrefix(...)` com
  prioridade 100, acima do router só-de-host (58). Zero DNS novo, e não há
  credencial de Cloudflare nesta máquina nem no VPS de qualquer forma.
- **O Studio não cabe numa sub-rota.** Ele é buildado com `basePath: ''`, que no
  Next é constante de build: sob `/supabase` o HTML pediria `/_next/static/...`,
  que o Traefik entregaria ao `productops-web` — que também é Next. Studio segue
  no túnel SSH (`8100`) até existir um host raiz para ele.
- **A API REST/Auth também não foi exposta.** Ela só serve o banco compartilhado
  `postgres`, e nenhum colaborador vive lá; expor seria superfície pública sem
  consumidor.
