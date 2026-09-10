---
name: stl-setup
description: One-time global onboarding of a STLFLIX collaborator's machine. Use when the SessionStart hook says "global setup not done", when the user says "configurar", "setup", "onboarding", "instalar o processo STLFLIX", or on the first session after installing stl-plugin. Installs the default global CLAUDE.md, asks for the projects folder ($PROJETOS) via AskUserQuestion, records ~/.claude/stl/config.json, and walks the OAuth of the GitHub and Vercel MCPs plus the Supabase CLI. Idempotent — safe to re-run.
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
---

# stl-setup — global onboarding (run once per machine)

Everything here is global (`~/.claude`). Per-project setup is `stl-project-init`.
Never guess a path or overwrite a file silently: every destructive step is
preceded by a backup and an AskUserQuestion.

## 1. Projects folder — `$PROJETOS`

Ask with **AskUserQuestion** (one question, header `Projetos`):

> "Em qual pasta ficam (ou vão ficar) os repositórios STLFLIX?"
> options: `~/Projetos` (Recommended) · `~/Developer` · `~/Code` — the user can type
> another path via *Other*.

Then, in Bash:

```bash
PROJETOS="$(python3 -c 'import os,sys;print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "<answer>")"
[ -d "$PROJETOS" ] || mkdir -p "$PROJETOS"
mkdir -p ~/.claude/stl
python3 - "$PROJETOS" <<'PY'
import json, sys, datetime, pathlib
p = pathlib.Path.home() / ".claude/stl/config.json"
cfg = json.loads(p.read_text()) if p.exists() else {}
cfg.update({"projetos": sys.argv[1], "setup_version": 1,
            "setup_at": datetime.date.today().isoformat()})
p.write_text(json.dumps(cfg, indent=2) + "\n")
print(p, cfg)
PY
```

`~/.claude/stl/config.json` is the single source of truth for `$PROJETOS`; the
SessionStart hook and `stl-project-init` read it from there.

## 2. Global CLAUDE.md

Template: `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.global.md` (replace `{{PROJETOS}}`
with the path above).

- If `~/.claude/CLAUDE.md` **does not exist**: render and write it.
- If it **exists**: back it up first
  (`cp ~/.claude/CLAUDE.md ~/.claude/CLAUDE.md.bak-$(date +%Y%m%d-%H%M%S)`), then
  **AskUserQuestion** (header `CLAUDE.md`):
  > "Já existe um ~/.claude/CLAUDE.md. O que fazer?"
  > `Substituir pelo padrão STLFLIX` (Recommended) · `Anexar o padrão ao final` ·
  > `Manter o meu e não instalar`
  Honour the answer literally. When appending, separate with a line
  `\n\n<!-- stl-plugin: STLFLIX defaults below -->\n\n`.

Render with:

```bash
sed "s|{{PROJETOS}}|$PROJETOS|g" "${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.global.md" > /tmp/stl-claude.md
```

## 3. Toolchain check (report, don't install silently)

```bash
for t in node pnpm git gh python3 supabase vercel; do printf '%-9s' "$t"; command -v "$t" >/dev/null && "$t" --version 2>/dev/null | head -1 || echo MISSING; done
```

Required: `node` ≥ 20.12, `pnpm`, `git`, `python3` (the `tlc-spec-driven` validators
are Python). Suggested install commands for what is missing (macOS):
`brew install node pnpm gh supabase/tap/supabase` · `npm i -g vercel`.
Ask before running any install.

## 4. Connections (OAuth via the bundled MCPs)

The plugin ships three MCP servers (`.mcp.json`); they start with the plugin.

| server | auth | how |
|---|---|---|
| `github` (`https://api.githubcopilot.com/mcp/`) | OAuth 2.0 | user runs `/mcp` → selects `stl-plugin:github` → *Authenticate* → browser |
| `vercel` (`https://mcp.vercel.com`) | OAuth 2.0 | same, `stl-plugin:vercel` |
| `firecrawl` (stdio) | API key | asked once at plugin enable (`userConfig.firecrawl_api_key`, Keychain) |

Tell the user, in one message, to run `/mcp` now and authenticate the two OAuth
servers; then confirm with `claude mcp list` (or `/mcp` again) that both show
*connected*. `gh auth login` is the fallback for GitHub if the org blocks the MCP.

**Supabase (self-hosted) has no OAuth MCP** — the hosted MCP is cloud-only (see
`docs/decisions/002-supabase-self-hosted-sem-mcp.md`). Connection is the CLI:

```bash
supabase --version                       # installed?
# per project, never global: the URL/keys live in the project's .env (gitignored)
supabase db push  --db-url "$SUPABASE_DB_URL"
supabase gen types typescript --db-url "$SUPABASE_DB_URL" > src/types/database.ts
```

Never paste a database URL or service key into the conversation; read them from
the project's `.env` inside Bash.

## 5. Done

Report in ≤ 6 lines: `$PROJETOS`, what happened to `CLAUDE.md` (written / appended /
kept + backup path), missing tools, MCP auth status. Then point to
`/stl-plugin:stl-project-init` for the first repo.
