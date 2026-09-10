---
name: prompt-creator
description: Turns a vague request into a complete, self-contained prompt before any work starts — for the current session, a subagent, or a teammate. Use when the user says "cria um prompt", "monta o prompt", "prepara a tarefa para X", when delegating via smart-dispatch, or when the request is ambiguous enough that starting to code would be a guess. Output always follows the six STLFLIX sections — Role, Context, Description, Tasks, Rules, Expected Output.
allowed-tools: Read, Bash, Grep, Glob, AskUserQuestion
---

# prompt-creator — six sections, zero guessing

A prompt is a contract. The reader (a fresh model, a subagent, a colleague) has none
of your context, so everything they need must be *in* the prompt, and everything
that is not needed must be out. The structure is fixed; the content is verified.

## Procedure

1. **Read before writing.** Open the files the task touches (`ls`, `grep -rn`,
   `head`). Copy real paths, real function names, real script names into the prompt.
   A prompt with an invented path fails on the first line.
2. **Resolve ambiguity now, not in the prompt.** If two readings lead to different
   work, ask the user with **AskUserQuestion** (≤ 3 questions) and bake the answer in.
   Never write "if X then A else B" into a prompt — decide.
3. **Size it.** One prompt = one deliverable a single agent can finish and verify.
   Bigger → split into sequential prompts with explicit handoff artefacts.
4. **Write the six sections** below, in this order, with these exact headings.
5. **Self-check** against the *Rules for the prompt itself* before delivering.

## The structure (mandatory, in order)

```markdown
# <task title — imperative, ≤ 10 words>

## Role
Who the executor is and what they are good at, in 1–2 lines
(e.g. "Senior Next.js 15 engineer working in a Supabase-backed monorepo").

## Context
The facts the executor cannot discover cheaply: repo + branch, the module and its
entry points (`path/to/file.ts:fn`), the stack versions, the relevant decisions
(`docs/decisions/NNN-…`), constraints (RAM, no API key, pnpm only), what already
exists and must not be rebuilt.

## Description
What is being asked and why — the outcome, in the user's terms. One paragraph.
Include the acceptance criteria as testable statements (EARS when it fits:
"WHEN <trigger> THE SYSTEM SHALL <response>").

## Tasks
Numbered, atomic, in execution order. Each task names its files and its check.
1. `path` — do X. Verify: `command`.
2. …
The last task is always the gate: `green-gate` (+ `security-check` when a merge follows).

## Rules
Hard constraints: scope (only these files), style (language of code/comments,
Conventional Commits), forbidden moves (no `any`, no empty catch, no new deps
without asking, no commit on `main`, never touch `.env`), and what to do when
blocked (stop and report, don't improvise).

## Expected Output
The exact shape of the reply: files changed (path + one line why), gate output
(last line), commits made (or "none"), open questions. State the format
(bullets/JSON/table) and the maximum length.
```

## Rules for the prompt itself
- Every path, symbol and command in the prompt exists — you checked.
- No pronouns without referents, no "as discussed", no "the usual way".
- Language: prompt body in the team's working language (PT-BR by default);
  code, paths, commands and identifiers in English.
- ≤ ~120 lines. Longer means the task is not sized — split it.
- Deliver the prompt as a single fenced markdown block, ready to paste or to pass
  to the Agent tool (`smart-dispatch` picks the model).
