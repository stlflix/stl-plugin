# stl-plugin — STLFLIX development process for Claude Code

One plugin that puts a collaborator's machine on the STLFLIX way of working:
global rules, connections, process skills and the design system.

## Install (collaborator)

```bash
claude plugin marketplace add stlflix/stl-plugin      # this repo is the marketplace
claude plugin install stl-plugin@stlflix               # asks for the Firecrawl API key
claude                                                 # new session
```

Then, inside Claude Code:

1. `/stl-plugin:stl-setup` — picks the projects folder (`$PROJETOS`), installs the
   global `~/.claude/CLAUDE.md`, checks the toolchain, guides `/mcp` OAuth for
   GitHub and Vercel.
2. `cd $PROJETOS/<repo>` → `/stl-plugin:stl-project-init` — creates the project
   `CLAUDE.md`, the default `.gitignore`, `docs/decisions/` and `docs/handoff/`.

The SessionStart hook reminds you of both while they are pending, and prints the
latest handoff of the project you open.

## What is inside

| component | file | purpose |
|---|---|---|
| MCP `github` | `.mcp.json` | OAuth 2.0 remote server (`api.githubcopilot.com/mcp/`) |
| MCP `vercel` | `.mcp.json` | OAuth 2.0 remote server (`mcp.vercel.com`) |
| MCP `firecrawl` | `.mcp.json` | web search + scrape; key via `userConfig` (Keychain) |
| MCP `supabase` | `.mcp.json` | your own database on the ops self-hosted Supabase; bearer token via `userConfig` |
| hook `SessionStart` | `hooks/hooks.json` → `scripts/session-start.sh` | setup nudges + last handoff |
| `stl-setup` | `skills/` | global onboarding (once per machine) |
| `stl-project-init` | `skills/` | first steps per repository |
| `prompt-creator` | `skills/` | Role · Context · Description · Tasks · Rules · Expected Output |
| `tlc-spec-driven` | `skills/` | Specify → Design → Tasks → Execute, with Python validators |
| `smart-dispatch` | `skills/` | model routing for subagents |
| `green-gate` | `skills/` | typecheck/lint/test gate, GREEN or not done |
| `security-check` | `skills/` | secret scan (blocking) + OWASP/RLS review |
| `atomic-commit` | `skills/` | Conventional Commits, one change per commit, never on `main` |
| `session-handoff` | `skills/` | linear `docs/handoff/NNN-date-slug.md` per session |
| `stl-design-system` | `skills/` | tokens, rules and primitive catalogue (snapshot of the platform) |
| `mcp-server` | `mcp-server/` | the MCP server behind the ops Supabase (deployed, not shipped to collaborators) |
| templates | `templates/` | `CLAUDE.global.md`, `CLAUDE.project.md`, `gitignore.default`, `handoff.md` |

Supabase self-hosted is reached through **our own** MCP server (`mcp-server/`), not
the hosted Supabase MCP, which is cloud-only. Each collaborator gets one database and
a bearer token; every query runs as their own Postgres role, so the isolation is the
database's, not our code's, and the connection string never leaves the server (see
`docs/decisions/005-mcp-proprio-para-o-supabase-do-ops.md`).

## Maintain (Lucas)

- The global CLAUDE.md the collaborators receive is `templates/CLAUDE.global.md`.
  Edit it here, bump `version` in `.claude-plugin/plugin.json`, push; `claude plugin
  update stl-plugin` on their side.
- Skills copied from `~/.claude/skills/` and from `whisper-agent/.claude/skills/`
  are snapshots — the plugin is downstream (`docs/decisions/004-...`).
- Design-system references are a snapshot of `plataforma-product-ops/src/design-system`;
  refresh them when the tokens change.
- Local test without installing: `claude --plugin-dir ~/Projetos/stl-plugin`.
- Validate: `claude plugin validate .`

Decisions live in `docs/decisions/` — `ls` is the index.
