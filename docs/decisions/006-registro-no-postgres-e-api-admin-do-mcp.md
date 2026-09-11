# 006 — O MCP provisiona e registra no Postgres; a plataforma é o cliente

**Status:** aceito · **Data:** 2026-09-11 · **Estende:** [005](005-mcp-proprio-para-o-supabase-do-ops.md)

## Contexto
A primeira versão do MCP (AD-005) lia dois arquivos montados no container:
`tokens.json` (sha256 → slug) e `collaborators/<slug>.env` (senha da role). Quem
escrevia neles eram três scripts bash rodando **no host**, por `docker exec`. Isso
travou o próximo passo: o Lucas quer que o colaborador se provisione pela
**plataforma** (`plataforma-product-ops`), e o container da plataforma não roda
`docker exec` no host nem escreve em arquivo do MCP.

## Decisão
- **O registro vive no Postgres**, schema `stl_mcp` do banco compartilhado
  `postgres` — que nenhum colaborador alcança (AD-005). Tabela
  `stl_mcp.collaborators`: slug, e-mail, banco, role, senha cifrada
  (AES-256-GCM sob `CREDENTIALS_KEY`, que só o servidor tem), hash do token e
  quando foi emitido. Um dump da tabela sozinho não abre nada.
- **O MCP provisiona.** A SQL dos scripts virou `src/provision.js`: um *plano*
  puro (testável sem banco) executado como `supabase_admin` via `ADMIN_DB_URL`.
  Ao subir, o servidor cria o schema e fecha o `CONNECT` do `PUBLIC` nos bancos
  compartilhados — o `harden-shared-db.sh` de antes, agora idempotente e automático.
- **API admin** em `/admin/*`, autenticada por `X-Admin-Key` em tempo constante,
  **nunca roteada pelo Traefik** (só loopback e rede docker): `GET` status,
  `PUT` provisiona (idempotente — rotaciona a senha, mantém o banco), `POST
  …/token` emite o bearer, mostrado uma vez. A plataforma é o chamador normal; o
  `curl` do host é o de emergência.
- **A stack do ops passa a ser versionada** em `ops/supabase/` (overlay do compose,
  gerador de `.env`, runbook). Os três scripts bash foram aposentados.
- **Studio por SSO**: o overlay roteia `db.stlflix.com.br` → envoy com
  `forwardAuth` na plataforma e injeção do Basic Auth do dashboard. As rotas de
  API do Studio (`/rest/`, `/auth/`, …) passam só pelo `forwardAuth`, sem o
  header — elas carregam o próprio `apikey`/`Bearer`, que o Basic sobrescreveria.

## O que foi medido (2026-09-11, `mkt-vps`)
- Re-provisionar `lucas` pela API devolveu `created: false`, rotacionou a senha e
  **manteve** `db_lucas` com a tabela `profiles` — o plano só emite `CREATE
  DATABASE` quando o banco não existe.
- Token antigo → 401 no mesmo segundo em que o novo foi emitido: um token vivo
  por colaborador, sem janela.
- **O Traefik ignora container com healthcheck em `starting`.** Logo depois do
  `up -d` os routers do Studio não apareciam na API dele, embora os middlewares
  já estivessem lá; com o envoy `healthy`, os três routers vieram. Não é erro de
  label — é esperar o healthcheck.
- 7 containers, ~540 MB reais; 3,8 GB livres no host.

## Consequências
- `ADMIN_DB_URL`, `ADMIN_KEY` e `CREDENTIALS_KEY` são **obrigatórias**: o servidor
  não sobe sem elas.
- Perder `CREDENTIALS_KEY` perde as senhas das roles — o remédio é `PUT` de novo em
  cada slug (rotaciona), não restaurar backup.
- `supabase db push` do colaborador continua fora (AD-005); `apply_migration` é o
  caminho.
