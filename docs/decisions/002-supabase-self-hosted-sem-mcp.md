# 002 — Supabase self-hosted entra pela CLI, não por MCP

**Status:** substituído por [005](005-mcp-proprio-para-o-supabase-do-ops.md) · **Data:** 2026-09-09

## Contexto
O pedido era OAuth 2.0 para GitHub, Supabase self-hosted e Vercel. O único MCP do
Supabase com OAuth é o hospedado (`https://mcp.supabase.com/mcp`, dynamic client
registration contra a org do Supabase Cloud). A documentação oficial diz: *"The
hosted Supabase MCP server is not designed for self-hosted configurations"* e
aponta PostgREST MCP ou Postgres MCP como alternativas — ambos autenticam por
connection string / service key, não por OAuth.

## Decisão
Nenhum MCP de Supabase no plugin. O acesso ao self-hosted é a CLI `supabase`
(`db push`, `gen types`, `migration`) lendo `SUPABASE_DB_URL`/chaves do `.env` do
projeto dentro do Bash — nunca coladas no prompt. Alternativas rejeitadas:
Postgres MCP (connection string sensível no Keychain do colaborador, tool schema
sempre carregado) e PostgREST MCP (service key com poder total exposta a cada
sessão).

## Consequências
- OAuth só existe para GitHub e Vercel; o README e o `stl-setup` dizem isso
  explicitamente.
- Quando o self-hosted ganhar um servidor MCP com OAuth próprio, esta decisão é
  substituída por outra que o adiciona ao `.mcp.json`.
- `security-check` trata `postgres://user:pass@` e `service_role` no diff como BLOCK.
