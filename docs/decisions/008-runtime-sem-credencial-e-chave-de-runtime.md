# 008 — O runtime das funções não tem credencial, e fala com o MCP por uma chave só dele

**Status:** aceito · **Data:** 2026-09-16 · **Estende:** [007](007-leitura-em-nome-do-slug-pela-api-admin.md)

## Contexto
As Edge Functions põem **código de terceiro** para rodar perto do banco: o
colaborador escreve TypeScript, publica, e a URL responde. O processo que tem a
`X-Admin-Key` provisiona banco, cria role e emite token — ele não pode ser o
mesmo que executa esse código. O desenho de isolamento da plataforma
(`.specs/features/buildloop-studio/design.md`, fronteiras **I3**, **I4** e **I5**)
separa três coisas que antes eram uma só: quem executa, quem tem credencial, e
quem tem chave.

Esta fase entrega o lado MCP disso — `edge.js`, `runtime-api.js` e `config.js`.
O container `functions` propriamente dito vem na fase seguinte, mas o contrato
com ele já está fechado aqui e é isto que se registra.

## Decisão
**A chave admin nunca sai deste processo.** O runtime recebe uma chave própria,
`RUNTIME_KEY`, e ela abre exatamente duas rotas, montadas em `/admin/runtime`
antes do router admin:

- `POST /admin/runtime/credential/:slug` → `{ database, user: "<slug>_fn", password }`,
  decifrado de `stl_mcp.collaborators.fn_password_enc`. A senha da role **dona**
  do banco está na mesma linha e não sai daqui.
- `POST /admin/runtime/function/:slug/:name` → `{ version, bundle, secrets }` da
  versão publicada; é o único lugar em que um secret é decifrado.

Qualquer outra rota sob esse prefixo é 404. **As duas chaves não se aceitam**
(I5): a admin devolve 401 em `/admin/runtime/*` e a de runtime devolve 401 em
`/admin/collaborators/:slug/token`, `/exec` e `/tickets/consume` —
`test/runtime-api.test.js` prova as duas direções.

**A role `<slug>_fn` não tem privilégio próprio** (I4, AD-006 desta fase): ela só
faz LOGIN e é membro de `_anon`/`_authenticated` com `WITH SET TRUE, INHERIT
FALSE`. Quem vazasse a credencial do runtime não leria uma tabela sem antes
`SET ROLE`, e aí a RLS vale — a role dona bypassaria.

**O processo-filho que roda o handler não tem credencial nenhuma** (I3): ele
recebe bundle e secrets pelo pai, e `ctx.sql` é RPC. Nenhuma connection string
atravessa essa fronteira.

**O ambiente é lido por allowlist** (I1, `src/config.js`): só
`PORT, DB_HOST, DB_PORT, STATEMENT_TIMEOUT_MS, ADMIN_DB_URL, ADMIN_KEY,
RUNTIME_KEY, CREDENTIALS_KEY, FUNCTIONS_URL`. E o servidor **recusa subir** se o
ambiente sequer mencionar a plataforma — qualquer env casando
`/N8N|PLATFORM|PRODUCTOPS|JWT_SECRET/i` derruba o boot nomeando a variável. Um
BuildLoop que alcança o banco da plataforma é justamente o que este desenho
existe para impedir.

## O que NÃO se faz, e por quê
- **Nenhuma rota de `exec` ou de provisionamento atrás da chave de runtime.**
  Se o container `functions` for comprometido, o que ele ganha é o que ele já
  tinha: rodar função de colaborador e falar com o banco como `_fn`.
- **Nenhum secret em rota de leitura.** `setSecrets` cifra com `CREDENTIALS_KEY`
  e devolve só as chaves; `secretKeys` idem. O valor decifrado existe em um
  único caminho, o `bundleFor` da rota de runtime.
- **Nenhuma compilação no host do colaborador.** O `esbuild` está em
  `dependencies` com **versão exata** (`0.28.2`) e roda aqui, no MCP: publicar é
  compilar e gravar `bundle` no banco dele. A fonte da verdade é o banco, não um
  volume.
- **Publicar não mexe na versão no ar quando não compila.** O `CompileError`
  (com `line` e `column` do esbuild) é lançado **antes** da transação; o rascunho
  é a versão 0 e `current_version` não anda. A versão anterior segue respondendo.

## Consequências
- Versão **0.4.0** (`package.json` e `Server.version`).
- **`RUNTIME_KEY` passa a ser obrigatória**: sem ela o processo não sobe. O
  `gen-env.py` e o compose da stack nativa a geram na fase de ops; até lá, um
  deploy desta imagem sem a variável falha no boot, de propósito e com a
  mensagem nomeando a env.
- `FUNCTIONS_URL` (padrão `http://functions:8300`) é o que a tool
  `invoke_edge_function` chama. Ela vai **sem bearer**: é a tool do dono, roda
  como `<slug>_anon`, e a descrição diz isso ao Claude.
- 179 testes no `node --test` (5 pulados sem docker), nenhum com banco real.
