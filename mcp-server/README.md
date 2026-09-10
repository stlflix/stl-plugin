# stl-supabase MCP server

Gives a STLFLIX collaborator their own database on the ops self-hosted Supabase,
over MCP, and nothing else.

- **Transport**: streamable HTTP, stateless — one server and one transport per
  request, so no session leaks between collaborators.
- **Auth**: `Authorization: Bearer <token>`. Only the sha256 of each token is on
  disk (`tokens.json`), so the file is not a list of credentials.
- **Isolation**: every query runs as the collaborator's own Postgres role. A bug
  in this server still cannot reach another collaborator's database — Postgres
  refuses the connection.
- **Tools**: `list_tables`, `describe_table`, `run_sql`, `apply_migration`,
  `list_migrations`.

The connection string never leaves the server, which is the objection that kept
Postgres MCP out of the plugin (`docs/decisions/002-supabase-self-hosted-sem-mcp.md`).

```bash
npm test                       # unit tests, no database needed
docker build -t stl-supabase-mcp .
```

| env | default | meaning |
|---|---|---|
| `PORT` | `8200` | listen port |
| `TOKEN_FILE` | `/etc/stl-supabase/tokens.json` | sha256 → slug map |
| `CREDENTIALS_DIR` | `/etc/stl-supabase/collaborators` | `<slug>.env` files from `provision-collaborator.sh` |
| `DB_HOST` / `DB_PORT` | `db` / `5432` | Postgres inside the Supabase network |
| `STATEMENT_TIMEOUT_MS` | `30000` | per-statement timeout |
