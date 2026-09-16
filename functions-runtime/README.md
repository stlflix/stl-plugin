# `stl-buildloop-functions` — runtime das Edge Functions

O *porquê* está em `../docs/decisions/008-runtime-sem-credencial-e-chave-de-runtime.md`
e no modelo de isolamento (I3, I4, I6) do design da feature. Isto é o *como*.

Um container, uma porta (`8300`), e **nenhuma credencial no processo que roda o
código do colaborador**. O pai busca bundle e secrets no MCP com a
`X-Runtime-Key`, escreve o bundle no tmpfs e conversa com o filho por IPC; o
filho não tem env, não tem rede de dados, não tem connection string.

```
/fn/:slug/:name   público   gateway → supervisor → filho
/auth/jwks        público   chave PÚBLICA ES256 da plataforma (max-age 300)
/_reload/:slug/:name  interno, X-Runtime-Key  invalida o bundle em cache
/healthz          público
```

## O contrato `ctx`

Uma função é um módulo ESM com um `export default`:

```ts
export default async (req: Request, ctx: Ctx): Promise<Response> => {
  const { rows } = await ctx.sql("select id, body from notes order by id desc limit 10");
  return Response.json({ rows, who: ctx.user.claims.email ?? null });
};
```

| campo | o que é |
| --- | --- |
| `req` | `Request` web-standard (Node 24). Corpo até **1 MB** — acima disso o pedido nem chega (413) |
| `ctx.sql(text, params?)` | **um** statement, protocolo estendido. Devolve `{ command, rowCount, fields, rows }`. Não aceita connection string, não aceita dois statements |
| `ctx.env` | só os secrets **daquela** função, decifrados. `process.env` é exatamente isto e nada mais |
| `ctx.user` | `{ role: "anon" \| "authenticated", claims }`. Sem bearer → `anon` com `claims` vazio |

**`ctx.sql` roda no processo-pai**, como `<slug>_anon` ou
`<slug>_authenticated` conforme o bearer, com `request.jwt.claims` setado —
então `auth.uid()` funciona e **a RLS vale**. A role dona do banco não é
alcançável de dentro da função: ela bypassaria a RLS, que é justamente o ponto.

`console.log/info/warn/error/debug` vira o `log[]` da invocação, visível na aba
"Logs" (últimas 200 por função, 24 h).

## Limites (BL-23)

| limite | o que acontece |
| --- | --- |
| 10 s por invocação | `SIGKILL` no filho, **504**; o pedido seguinte respawna |
| 128 MB por filho | `--max-old-space-size`; sair por OOM vira **503** |
| 120 req/min por slug | **429** com `Retry-After` |
| corpo > 1 MB | **413**, antes de ler o corpo |
| 5 s por `ctx.sql` | `statement_timeout` local à transação |
| ocioso 60 s | o filho morre; o próximo pedido paga ~100 ms de cold start |

Toda resposta sai com `Cache-Control: private, no-store`. Isso é correto e
**não** é o que fecha o vazamento de cache: o host precisa estar na zona
`stlflix.com` ou em DNS-only (ver `../ops/buildloop/README.md`).

## O que o filho não pode

Roda sob `node --permission --allow-fs-read=/var/fn/<slug> --max-old-space-size=128`,
sem `--allow-child-process` e sem `--allow-worker`. Medido em `test/child.test.js`
com um filho de verdade: `fs` fora daquele diretório e `child_process.spawn`
lançam `ERR_ACCESS_DENIED`; o canal IPC continua funcionando.

> O permission model do Node **não é uma sandbox contra código hostil** — o
> próprio Node diz isso. O modelo de ameaça aqui é colaborador interno com
> código descuidado. O que fecha o resto é o container (`read_only`,
> `cap_drop: [ALL]`, sem docker socket) e o fato de `<slug>_fn` não ter
> privilégio nenhum por si.

## Rodar

```bash
npm install
npm test                 # unit + filho real; a integração pula sem docker, dizendo
npm run test:integration # precisa de docker: postgres:16 efêmero
MCP_URL=http://mcp:8200 RUNTIME_KEY=… AUTH_PUBLIC_KEY="$(cat pub.pem)" npm start
```

O `.env` da stack é gerado por `../ops/buildloop/gen-env.py`. O processo
**recusa subir** se o ambiente mencionar `ADMIN_KEY`, `CREDENTIALS_KEY`, a
plataforma ou qualquer coisa `*PRIVATE*` — a chave que assina identidade mora na
plataforma e este processo só verifica.
