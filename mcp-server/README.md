# stl-supabase MCP server

Gives a STLFLIX collaborator their own database on the ops self-hosted Supabase,
over MCP, and nothing else.

- **Transport**: streamable HTTP, stateless — one server and one transport per
  request, so no session leaks between collaborators.
- **Auth**: `Authorization: Bearer <token>`. Only the sha256 of each token is
  stored, so the registry is not a list of credentials.
- **Isolation**: every query runs as the collaborator's own Postgres role. A bug
  in this server still cannot reach another collaborator's database — Postgres
  refuses the connection.
- **Registry**: `stl_mcp.collaborators` in the shared `postgres` database, which
  collaborators cannot CONNECT to. Role passwords are AES-256-GCM under
  `CREDENTIALS_KEY`; the connection string never leaves the server.
- **Tools**: `list_tables`, `describe_table`, `run_sql`, `apply_migration`,
  `list_migrations`.

## Admin API (`X-Admin-Key`, never routed by Traefik)

| call | effect |
|---|---|
| `GET /admin/collaborators/:slug` | status: database, whether a token exists, when it was issued |
| `PUT /admin/collaborators/:slug` `{email}` | provision (role + `db_<slug>` + no CONNECT anywhere else). Idempotent: rotates the role password, keeps the database |
| `POST /admin/collaborators/:slug/token` | issue the bearer token — shown once, replaces the previous one |

The platform (`plataforma-product-ops`, module `supabase`) is the normal caller.
From the ops host:

```bash
cd /home/ubuntu/supabase-ops/supabase/docker
KEY=$(grep ^MCP_ADMIN_KEY= .env | cut -d= -f2-)
curl -s -X PUT  -H "X-Admin-Key: $KEY" -H 'Content-Type: application/json' \
     -d '{"email":"alice@stlflix.com"}' http://127.0.0.1:8200/admin/collaborators/alice
curl -s -X POST -H "X-Admin-Key: $KEY" http://127.0.0.1:8200/admin/collaborators/alice/token
```

At boot the server creates the registry and closes the default `PUBLIC` CONNECT
on `postgres`, `template1` and `_supabase` (service roles keep theirs, explicitly).

```bash
npm test                       # unit tests, no database needed
docker build -t stl-supabase-mcp .
```

| env | default | meaning |
|---|---|---|
| `PORT` | `8200` | listen port |
| `DB_HOST` / `DB_PORT` | `db` / `5432` | Postgres inside the Supabase network |
| `ADMIN_DB_URL` | — | `postgres://supabase_admin:…@db:5432/postgres` (required) |
| `ADMIN_KEY` | — | shared secret for `/admin/*` (required) |
| `CREDENTIALS_KEY` | — | 64 hex chars; encrypts role passwords at rest (required) |
| `STATEMENT_TIMEOUT_MS` | `30000` | per-statement timeout |

The ops stack that runs this lives in `../ops/supabase/`.
