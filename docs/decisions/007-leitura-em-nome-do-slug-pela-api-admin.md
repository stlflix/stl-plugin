# 007 — A API admin lê o banco do colaborador em nome do slug, com a role dele

**Status:** aceito · **Data:** 2026-09-15 · **Estende:** [006](006-registro-no-postgres-e-api-admin-do-mcp.md)

## Contexto
O colaborador tem `db_<slug>` e o alcança pelo Claude Code via `/mcp`. Nenhuma
interface mostra o que há dentro: o Studio self-hosted só vê o banco `postgres`
compartilhado, e um Studio por colaborador (satélite `meta`+`studio`, ~360 MB no
AD-005, 237 MB medidos em 2026-09-15) foi descartado pelo Lucas — o `mkt-vps` tem
~3,5 GB livres. A plataforma (`plataforma-product-ops`) quer mostrar tabelas e
rodar consultas, mas não tem credencial de banco nem o bearer do colaborador
(o token é mostrado uma vez, AD-004 dela), e não deve ter nenhum dos dois.

## Decisão
Duas rotas novas na API admin (`X-Admin-Key`, nunca roteada pelo Traefik):

- `POST /admin/collaborators/:slug/tables` — corpo `{}` lista (`LIST_TABLES_SQL`,
  agora com `estimated_rows` de `pg_class.reltuples`, `null` quando `-1`); corpo
  `{ table }` descreve (`DESCRIBE_SQL`). As SQLs saíram de `tools.js` para
  `src/catalog.js`: a tool `list_tables` e a rota listam **a mesma coisa**.
- `POST /admin/collaborators/:slug/query` — `{ sql, limit? }`. Executa em
  `BEGIN READ ONLY` + `SET LOCAL statement_timeout = 5000`, em modo array
  (`rows[i][j]` casa com `columns[j]`, colunas homônimas sobrevivem), tipos por
  `format_type` na mesma transação, `COMMIT`; `ROLLBACK` e `release()` em erro.
  Devolve `columns`, `rows`, `rowCount` (real) e `truncated` (cortou em `limit`,
  padrão 100, teto 500). Erro com SQLSTATE volta **422** `{ error, code }` — a
  recusa é do Postgres (`25006` para escrita), e a mensagem é o que o colaborador
  precisa ler; erro sem SQLSTATE continua 500.

**As duas rotas abrem o pool só por `pools.forSlug(slug)`** — a role do próprio
colaborador. O `adminPool` (`supabase_admin`) não aparece no corpo delas, e
`test/admin.test.js` o injeta como um `Proxy` que lança em qualquer acesso.

## O que NÃO se faz, e por quê
- **Nenhum parser de SQL** para decidir se é leitura. `WITH … INSERT`, `DO $$`,
  função com efeito colateral — regex não pega, `READ ONLY` pega.
- **Nenhum `pg-cursor`**: o servidor executa e corta em memória. O `statement_timeout`
  de 5 s limita o custo, e o banco é o do próprio colaborador. Se um dia doer,
  `DECLARE … FETCH` dentro da mesma transação é o caminho — não uma dependência.
- **Nenhuma terceira rota** para "prévia de tabela": a plataforma monta
  `SELECT * FROM "s"."t" LIMIT 100 OFFSET n` e usa `query`.

## Consequências
- Versão `0.3.0`. Deploy pelo runbook `ops/supabase/README.md` ("Atualizar o MCP"):
  `docker build -t stl-supabase-mcp:0.3.0 mcp-src`, `MCP_IMAGE_TAG=0.3.0`,
  `docker compose up -d mcp`. Até isso rodar, a plataforma recebe 404 nessas rotas
  e mostra "Servidor MCP recusou".
- O `estimated_rows` é aditivo na tool `list_tables`; nenhum consumidor quebra.
- 28 testes, sem banco: plano puro (`readonly.test.js`) + rota HTTP em porta
  efêmera (`admin.test.js`).
