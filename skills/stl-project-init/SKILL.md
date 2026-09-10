---
name: stl-project-init
description: First steps in a STLFLIX repository — creates the project CLAUDE.md through AskUserQuestion, installs the default .gitignore (node_modules, every .env spelling, build output, OS files), and scaffolds docs/decisions/ and docs/handoff/. Use when the SessionStart hook says the project has no CLAUDE.md, when starting a new repo, cloning an existing one for the first time, or when the user says "iniciar projeto", "criar CLAUDE.md", "primeiros passos". Idempotent — merges into existing files instead of overwriting.
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
---

# stl-project-init — first steps per project

Run from the repository root. Requires `stl-setup` done (`~/.claude/stl/config.json`).

## 0. Ground truth first (never assume the stack)

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$ROOT"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || git init -q
ls -A
[ -f package.json ] && python3 -c 'import json;d=json.load(open("package.json"));print("scripts:",json.dumps(d.get("scripts",{}),indent=1));print("deps:",list(d.get("dependencies",{}))[:30])'
ls pyproject.toml requirements.txt supabase/config.toml vercel.json next.config.* 2>/dev/null
```

Detect: package manager (lockfile), framework (`next`, `vite`, `express`…), test
runner, `typecheck`/`lint` scripts, Supabase (`supabase/`), Vercel (`vercel.json`
or `.vercel/`). This is what you propose as defaults — the user confirms.

## 1. Ask (AskUserQuestion, one call, up to 4 questions)

1. header `Projeto` — "O que é este projeto, em uma frase?" — options are the 2–3
   best guesses from `package.json` `description`/README; the real answer usually
   comes via *Other*.
2. header `Stack` — options from detection, e.g. `Next.js + pnpm + Supabase`,
   `Node/TypeScript API`, `Python (uv)`, *Other*.
3. header `Gate` — "Quais comandos definem 'pronto'?" — options built from the
   detected scripts, e.g. `pnpm typecheck && pnpm lint && pnpm test` (Recommended),
   `pnpm typecheck && pnpm test`, `uv run pytest -q`.
4. header `Deploy` — `Vercel` · `Vercel + Supabase self-hosted` · `Sem deploy (lib/CLI)` · *Other*.

If the repo already has a `CLAUDE.md`, read it first and ask a single extra
question: `Manter` · `Reescrever no padrão STLFLIX` · `Anexar seção STLFLIX`.

## 2. Render `CLAUDE.md`

Template `${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.project.md`. Placeholders:
`{{PROJECT_NAME}}` (basename of ROOT), `{{PROJECT_DESCRIPTION}}`, `{{STACK}}`,
`{{COMMANDS}}` (the real scripts, one per line, with a short comment),
`{{GATE}}`, `{{DEPLOY}}`, `{{EXTRA_RULES}}` (constraints the user mentioned; empty
otherwise — remove the placeholder line). Keep it under ~80 lines.

## 3. `.gitignore` — merge, never clobber

```bash
TPL="${CLAUDE_PLUGIN_ROOT}/templates/gitignore.default"
if [ ! -f .gitignore ]; then cp "$TPL" .gitignore
else
  { echo; echo "# --- added by stl-plugin ($(date +%F)) ---"
    grep -vE '^\s*(#|$)' "$TPL" | while IFS= read -r line; do grep -qxF -- "$line" .gitignore || echo "$line"; done
  } >> .gitignore
fi
git ls-files -z | tr '\0' '\n' | grep -E '(^|/)\.env($|\.)' && echo "WARNING: .env files are already tracked — untrack with git rm --cached"
```

If a tracked `.env*` shows up, stop and tell the user: the key is compromised the
moment it was pushed; rotate it, then `git rm --cached`.

## 4. Knowledge folders

```bash
mkdir -p docs/decisions docs/handoff
[ -f docs/decisions/README.md ] || printf '# Decisions\n\nOne decision per file: `NNN-slug.md`, linear numbering. `ls` is the index.\nTemplate: title, **Status**, **Date**, Context, Decision, Consequences.\n' > docs/decisions/README.md
[ -f docs/handoff/README.md ]   || printf '# Handoff\n\nOne file per session: `NNN-YYYY-MM-DD-slug.md`, linear, never overwritten (skill `session-handoff`).\nStart a session by reading the highest-numbered file.\n' > docs/handoff/README.md
```

## 5. Report

`git status --short` and a ≤ 5-line summary: CLAUDE.md written/appended/kept,
`.gitignore` created/merged (N lines added), folders created, warnings. Do **not**
commit — the user decides (`atomic-commit` when asked).
