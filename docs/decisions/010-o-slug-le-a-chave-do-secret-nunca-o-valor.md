# 010 — O slug lê a *chave* do secret, nunca o valor: GRANT de coluna

**Status:** aceito · **Data:** 2026-09-17 · **Corrige:** [009](009-metadados-de-edge-function-escritos-pelo-admin-no-banco-do-slug.md)

## Contexto
O AD-009 desenhou a tabela de quem usa qual pool e colocou `edge.list` em
`forSlug` — "`SELECT` é direito do slug". Mas o SQL que o `list` executa lê a
tabela que o mesmo AD revoga:

```sql
COALESCE((SELECT array_agg(s.key ORDER BY s.key)
          FROM buildloop.edge_function_secrets s WHERE s.name = f.name), '{}') AS secret_keys
```

O resultado, medido em produção no UAT de 2026-09-17: **`edge/list` responde 502
para todo colaborador**, com `permission denied for table edge_function_secrets`.
`save`, `publish` e `setSecrets` respondem 200 porque abrem o pool admin — a
superfície inteira funciona por baixo e nada dela aparece no painel, que fica em
"Falha (502)" e segue dizendo "Nenhum secret definido".

Nenhuma suíte pegou isso: `test/edge.test.js` dirige um pool falso, e pool falso
não tem privilégio para negar.

## Decisão
O slug ganha `SELECT` **nas colunas `name` e `key`**, e só nelas:

```sql
REVOKE ALL ON buildloop.edge_function_secrets FROM <slug>, <slug>_anon, <slug>_authenticated, <slug>_fn;
GRANT SELECT (name, key) ON buildloop.edge_function_secrets TO <slug>;
```

O `value_enc` continua inalcançável para ele. O `list` segue em `forSlug`, como
o AD-009 desenhou, e passa a poder executar o que sempre quis executar.

## Por que de coluna, e não mover o `list` para o pool admin
Mover o `list` para `adminForSlug` seria uma linha e dispensaria migração, mas
trocaria o limite de lugar: hoje quem impede o colaborador de ler o valor do
secret é o **Postgres**, e passaria a ser a escolha de pool no nosso código. A
frase do AD-005 — "o isolamento é do próprio Postgres, não do nosso código" — é o
que sustenta todo o resto do desenho; ela não se gasta por um `SELECT`.

O risco que o AD-009 nomeia para revogar a tabela continua fechado, porque ele é
sobre uma coluna específica: *"se a role do colaborador lesse
`edge_function_secrets`, `SELECT value_enc` num `query` devolveria o ciphertext
de todos os secrets"*. Com o grant de coluna, `SELECT value_enc` e `SELECT *`
falham para o slug exatamente como falhavam antes — o que passa a responder é a
lista de chaves, que é o que a tool sempre prometeu ("the KEYS of its secrets,
never their values").

## Rollout
Banco já provisionado não recebe o plano de novo: `PUT /admin/collaborators/:slug`
rotaciona a senha da role sob um pool vivo. Por isso o grant vai também num
script de uma passada, `ops/buildloop/scripts/grant-secret-keys.mjs`, que roda
como admin em cada `db_<slug>` do registro e é idempotente.

## Consequências
- `provisionPlan` passa a emitir duas sentenças no lugar de uma; o teste do plano
  cobra as duas, na ordem (revoke antes do grant).
- **O sensor que faltava passa a existir:** `test/edge.integration.test.js` sobe
  um Postgres 16 real, provisiona, conecta **como a role do slug** e roda o
  `LIST_SQL` de verdade — mais uma prova negativa de que `value_enc` e `SELECT *`
  seguem recusados. Falha antes desta mudança, passa depois; é a classe de erro
  que pool falso nunca vai ver.
- `GRANT` de coluna não é herdado por tabela nova: se `edge_function_secrets`
  ganhar coluna um dia, ela nasce invisível para o slug — que é o padrão certo.
