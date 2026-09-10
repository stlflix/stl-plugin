---
name: atomic-commit
description: Use when committing work — after green-gate and security-check pass, when finishing a task, or when the user asks to commit. Enforces atomic commits (one logical change each) with rigorous Conventional Commits messages in English, on a topic branch never on main. Splits unrelated changes into separate commits. Trigger before any `git commit`. Only commit when the task implies it or you were asked — never commit unprompted exploratory work.
allowed-tools: Bash, Read
---

# atomic-commit — small, focused, conventional

## Rules
- **Atomic**: one logical change per commit. If the diff mixes concerns (a feature +
  an unrelated rename), stage and commit them separately (`git add -p`).
- **Conventional Commits, English, imperative**: `type(scope): summary` —
  e.g. `feat(api): add webhook parsing for n8n payload`.
  Types: `feat fix refactor docs test chore build perf style ci revert`.
  Summary ≤ 72 chars, no trailing period.
- **Body** (when the why isn't obvious): wrap at ~72 cols, explain the reason, not
  the mechanics.
- **Branch**: never commit on `main`/`master`. If you are there, create
  `<type>/<slug-kebab>` first (`git switch -c feat/<slug>`).
- **Secrets**: `.env*`, keys and dumps never get staged — run `security-check`
  before the first commit of a task.
- **When**: commit when the task implies it or the user asked. Not half-done work,
  not unprompted exploration.

## Procedure
1. Confirm the diff is clean and reviewed (`green-gate` GREEN, `security-check` clean).
2. `git branch --show-current` — on `main`? create the topic branch first.
3. Stage the one logical change (`git add -p` for partials). `git diff --cached --stat`.
4. Validate the message before committing:

   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/skills/atomic-commit/check-msg.sh" "feat(scope): summary"
   ```

5. Commit. End the message with the trailer the harness asks for
   (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`).
6. Repeat for the next logical change. Never squash unrelated work into one commit.
