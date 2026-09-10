---
name: session-handoff
description: Use BEFORE a /clear or /compact, when ending a session, or whenever context is about to be wiped — writes a NEW numbered handoff file in the project's docs/handoff/ (linear, never overwritten) so the next session resumes with zero loss. Triggers on "salvar contexto", "handoff", "antes de limpar/clear/compactar", "fechar o dia", or detecting an imminent /clear. Also use at session START to resume: read the highest-numbered handoff.
allowed-tools: Read, Write, Bash
---

# session-handoff — linear, per-project, one file per session

Context eviction (`/clear`, `/compact`, session end) destroys working memory. This
skill persists the *durable* slice to the repo **before** the wipe. The store is
linear like `docs/decisions/`: every session appends a new file, nothing is ever
overwritten, and `ls` is the index.

```
docs/handoff/
├── README.md
├── 001-2026-09-09-bootstrap-auth-module.md
├── 002-2026-09-10-rls-policies.md
└── 003-2026-09-10-rls-policies-fix.md      ← highest number = where we are
```

Durable knowledge does **not** live here: a trade-off, a discovered limit, a design
choice goes to `docs/decisions/NNN-slug.md` and the handoff *references* it.

## When to fire
- The user says they will `/clear`, `/compact`, reset, "limpar a sessão", "fechar".
- End of a non-trivial session (something changed on disk or a decision was made).
- Do NOT fire for trivial/exploratory turns — nothing durable to save.

## Resume (start of session)
```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ls "$ROOT/docs/handoff" 2>/dev/null | grep -E '^[0-9]{3}-' | sort | tail -1
```
Read that file (only that one) before touching code. Check its "Threads em aberto".

## Procedure (save)

1. **Facts, not guesses** — the project is the cwd's git root, never a hardcoded path:
   ```bash
   ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$ROOT"
   mkdir -p docs/handoff
   LAST="$(ls docs/handoff | grep -E '^[0-9]{3}-' | sort | tail -1)"
   NNN="$(printf '%03d' $(( ${LAST:0:3} + 1 )))"        # 001 when LAST is empty
   DATE="$(date +%F)"; AUTHOR="$(git config user.name)"
   BRANCH="$(git branch --show-current)"; TREE="$([ -z "$(git status --short)" ] && echo clean || echo dirty)"
   git status --short; git log --oneline -8
   ```
   Not a git repo → `Branch: n/a`, `Tree: n/a`, say which dir the session ran in.

2. **Multi-project sessions** — worked in more than one repo? Repeat for each root,
   one file per project. Never merge two projects into one handoff.

3. **Distill, don't dump.** Keep only durable signal: what changed, current state,
   open threads + next step, key files (with *why*), decisions made (as links to
   `docs/decisions/`), context that would otherwise be re-discovered. Drop the
   noise (60–70% of a session).

4. **Decision gap-check.** Something durable decided this session that has no AD yet?
   Write `docs/decisions/NNN-slug.md` first (title, Status, Date, Context, Decision,
   Consequences), then reference it from the handoff.

5. **Write the new file** `docs/handoff/${NNN}-${DATE}-<slug>.md` from
   `${CLAUDE_PLUGIN_ROOT}/templates/handoff.md` (`<slug>` = 2–5 kebab words naming
   the session's subject; `{{PREVIOUS}}` = `$LAST` or `—`). Carry forward every
   still-open thread from the previous handoff so nothing silently drops.

6. **Confirm in one line**: `Handoff salvo — docs/handoff/NNN-... — pode limpar.`
   Commit only if the user's flow commits docs (`atomic-commit`, type `docs`).

## Hard rules
- Never edit or delete an earlier handoff — append a new one, even for a fix.
- Never write another project's handoff from this cwd.
- The handoff is the *resume snapshot*; `docs/decisions/` is the knowledge base.
  Same content in both stores is forbidden — the second references the first.
