---
name: green-gate
description: Use right BEFORE declaring any coding task done or telling the user a change is finished. Detects the project's stack and runs its checks (typecheck, lint, tests); fixes your own errors silently and re-runs until green. Never report "done" on red. Trigger at the end of every implementation, bugfix, or refactor — done means the gate is green, not "I think it works".
allowed-tools: Bash, Read, Edit
---

# green-gate — done means green

A task is finished only when the project's own checks pass. Self-reported "done"
without running them is not done. This is the self-healing mandate as a hard gate.

## Procedure

1. Heavy process — run it serially, never alongside another build or test run.
2. Run the gate (auto-detects the stack, runs what exists):

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/skills/green-gate/gate.sh"
   ```

   If the project's `CLAUDE.md` names a different gate command, that one wins —
   run it instead.
3. `RED` → read the failure, **fix your own error**, re-run. Repeat until `GREEN`.
   Do not move on, do not hand back, do not mark work done on red. Never "fix" a
   failure by deleting the test or loosening the type.
4. Only after `GREEN`: report done, quoting the last line of the gate output.

## What it runs (whatever is present)
- `package.json` scripts, in order: `typecheck` → `lint` → `test` (pnpm > npm; the
  `web/` or `src/web/` subfolder counts too).
- `pyproject.toml` → `uv run pytest -q` (or `pytest -q`).
- `Cargo.toml` → `cargo test --quiet`.
- No recognized check → `RED` on purpose: verify manually and say so.
