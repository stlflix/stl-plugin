---
name: security-check
description: Pre-merge security audit of the current diff or branch. Use before every merge/PR, before the first commit of a task, when touching auth, migrations, RLS, env handling, file uploads or any HTTP handler, or when the user says "security", "auditoria", "segurança", "checa antes de mergear". Scans for leaked secrets and tracked .env files (blocking), then reviews the diff for OWASP top-10 patterns, Supabase RLS gaps and dependency advisories. Reports findings ranked CRITICAL → LOW with file:line.
allowed-tools: Bash, Read, Grep, Glob
---

# security-check — the diff does not merge until this is clean

Two layers: a **deterministic scan** (script, blocking on secrets) and a **review**
(you, reading the diff with a checklist). Neither replaces the other.

## 1. Deterministic scan (always first)

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/security-check/scripts/secret-scan.sh"           # working tree + staged vs HEAD
bash "${CLAUDE_PLUGIN_ROOT}/skills/security-check/scripts/secret-scan.sh" main       # whole branch vs main
```

Exit 2 = **BLOCK**: a secret pattern or a tracked `.env*` file. Do not commit, do
not merge. Tell the user which file:line; if it was ever pushed, the key is
compromised — rotate first, then remove (`git rm --cached`, `.gitignore`).
Exit 1 = warnings to review. Exit 0 = clean.

## 2. Review the diff (`git diff <base>...HEAD`, or `git diff` + `git diff --cached`)

Read every changed hunk with this checklist. Cite `file:line` for each finding.

| area | look for |
|---|---|
| Injection | string-built SQL/shell/HTML; `dangerouslySetInnerHTML`; `eval`/`Function`; unparameterised `execute_sql`/`run-sql` calls |
| AuthN/AuthZ | route handlers / server actions without a session check; trusting client-sent `user_id`/`role`; JWT claims used as columns |
| Supabase | new table/view without `enable row level security` + policies; `service_role` key reaching the client bundle (`NEXT_PUBLIC_*`); anon key doing writes RLS doesn't cover |
| Secrets & config | hardcoded URLs with credentials; `.env.example` with real values; logging of tokens/headers/bodies |
| Input validation | request bodies without Zod/Pydantic; file uploads without type/size limit; path built from user input |
| Data exposure | `select *` returned to the client; error messages leaking stack/SQL; PII in logs |
| Web | missing CSRF on state-changing GET; open redirects; CORS `*` with credentials; `unsafe-inline` CSP additions |
| Crypto/random | `Math.random` for tokens; MD5/SHA1 for passwords; custom crypto |
| Dependencies | new packages: `pnpm audit --prod` / `pip-audit` / `uv pip audit`; typosquats; postinstall scripts |
| Infra | Dockerfile running as root; secrets baked in image layers; `vercel.json` exposing env to client |

## 3. Report

```
SECURITY-CHECK — <branch> vs <base> — N findings
CRITICAL  path:line — what · why it matters · fix
HIGH      …
MEDIUM    …
LOW       …
Scan: clean | BLOCK (secrets) · Deps: clean | advisories
Verdict: MERGE OK | FIX FIRST
```

`MERGE OK` only with zero CRITICAL/HIGH and a clean scan. Fix what is yours; for
pre-existing issues outside the diff, list them under "fora do escopo" — don't
silently widen the change.
