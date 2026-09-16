# 009 — Os metadados das Edge Functions são escritos pelo admin, dentro do banco do slug

**Status:** aceito · **Data:** 2026-09-16 · **Estende:** [008](008-runtime-sem-credencial-e-chave-de-runtime.md)

## Contexto
O plano de provisionamento (`commonPlan`) cria o schema `buildloop` dentro de
`db_<slug>` com **owner `buildloop_admin`**, e dá ao colaborador exatamente isto:

```sql
GRANT USAGE ON SCHEMA buildloop TO <slug>, <slug>_fn;
GRANT SELECT ON buildloop.edge_functions, buildloop.edge_function_versions,
      buildloop.invocations TO <slug>;
GRANT INSERT ON buildloop.invocations TO <slug>_fn;
REVOKE ALL ON buildloop.edge_function_secrets FROM <slug>, <slug>_anon, <slug>_authenticated, <slug>_fn;
```

Ou seja: o slug **lê** suas funções, versões e invocações, e **não escreve nada**
nem enxerga um secret. Mas `edge.js` — `save`, `publish`, `setSecrets`,
`secretKeys`, `bundleFor` — estava rodando em `pools.forSlug(slug)`, a conexão
com a role do próprio colaborador. Contra os mocks dos testes isso passa; contra
um Postgres de verdade, todo `INSERT INTO buildloop.edge_function_versions` e
todo `SELECT … FROM buildloop.edge_function_secrets` seria `permission denied`.
O bug estava no lado de quem conecta, não no plano de GRANT — o plano é o
desenho, e ele está certo.

## Decisão
**Escrita de metadado de Edge Function e acesso a secret vão por uma conexão de
admin ao banco `db_<slug>`** — a mesma identidade que o provisionamento já usa
lá dentro. `PoolRegistry` ganha `adminForSlug(slug)`: um pool por banco de slug,
credencial vinda de `ADMIN_DB_URL`, `database = db_<slug>`, mesma disciplina de
`max` e de cache que `forSlug`, e o mesmo erro "is not provisioned" para slug
que não existe. É um pool por slug também — nada aqui alcança o banco de outro
colaborador.

Quem usa qual:

| operação | pool | por quê |
| --- | --- | --- |
| `edge.list`, `edge.logs` | `forSlug` | `SELECT` é direito do slug; o que a role dele não vê, a plataforma não mostra (AD-007) |
| `edge.save`, `edge.publish`, `edge.setSecrets`, `edge.secretKeys` | `adminForSlug` | escrita no schema do admin |
| `edge.bundleFor` (rota de runtime) | `adminForSlug` | decifra secret: o slug não pode nem ler a tabela |

Vale para os três chamadores: a rota `POST /admin/collaborators/:slug/edge`, a
rota `POST /admin/runtime/function/:slug/:name` e as tools MCP
`deploy_edge_function` e `set_secrets`. `list_edge_functions` segue no pool do
slug.

## Por que o slug não escreve o metadado do próprio projeto
- **Secret tem de ser ilegível para ele.** `ctx.env` chega ao filho pelo pai; se
  a role do colaborador lesse `edge_function_secrets`, `SELECT value_enc` num
  `query` devolveria o ciphertext de todos os secrets de todas as funções dele —
  e a `CREDENTIALS_KEY` é a mesma do servidor inteiro.
- **Versão publicada é trilha de auditoria.** `edge_function_versions` é o que
  diz qual código está no ar agora e qual estava ontem. Se o dono do banco
  pudesse reescrever `bundle` de uma versão já publicada, o runtime serviria
  código que nunca passou pelo `publish` — e o `esbuild` do MCP, que é a única
  compilação do sistema, deixaria de ser o caminho obrigatório.
- **`current_version` é o interruptor do que responde na URL pública.** Ele anda
  na transação do `publish`, depois da compilação; um `UPDATE` direto pularia o
  "não compila, não publica" do AD-008.

## A leitura do I7
O I7 do design diz "toda escrita passa pela role owner do slug, nunca
`adminPool`". Isso continua valendo e não é o que muda aqui:

- **I7 é sobre os DADOS do colaborador** — o que ele escreve via `exec`, no
  schema `public`, que ele é dono. Essa escrita segue em `pools.forSlug`, e o
  `Proxy` de `test/admin.test.js` continua estourando se qualquer rota de dados
  tocar o `adminPool`.
- **`adminPool` ≠ `adminForSlug`.** O `adminPool` é o banco de manutenção
  (`postgres`, onde mora `stl_mcp`) e nenhuma rota de dados o toca. O
  `adminForSlug` é o banco **do colaborador**, aberto por outra role. A fronteira
  que o I7 defende — um colaborador não alcança o que é do outro — é a do banco,
  e ela não se mexe.
- **Metadado de projeto é do admin por desenho**, não por acidente: a linha
  "Metadados do projeto dentro do `db_<slug>`, owner admin; secrets fora do
  alcance do slug por GRANT" nas Tech Decisions do design já dizia quem é o dono.
  Faltava só a conexão combinar com o GRANT.

## Consequências
- `PoolRegistry` recebe `adminConnection` no construtor (`server.js` passa a
  mesma que `executePlan` usa). Sem ela, `adminForSlug` recusa com mensagem
  própria — um registry de teste não vira silenciosamente um pool errado.
- `drop(slug)` e `closeAll()` fecham os dois pools do slug.
- `test/db.test.js` (novo) prova que os dois pools abrem o **mesmo** banco com
  roles diferentes e que são cacheados separadamente; `admin.test.js` prova que
  `publish`/`secrets` só abrem `adminForSlug` e que `list`/`logs` só abrem
  `forSlug`; `runtime-api.test.js` prova o mesmo para `bundleFor`.
- `provision.test.js` não afrouxa: "secrets by neither" é justamente o motivo
  desta decisão existir.
- 187 testes no `node --test` (5 pulados sem docker).
