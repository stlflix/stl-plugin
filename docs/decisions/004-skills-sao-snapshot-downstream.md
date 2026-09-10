# 004 — As skills do plugin são snapshots; a fonte está fora do plugin

**Status:** aceito · **Data:** 2026-09-09

## Contexto
`tlc-spec-driven` veio de `whisper-agent/.claude/skills/`; `smart-dispatch`,
`atomic-commit`, `green-gate` e a ideia do `session-handoff` vieram de
`~/.claude/skills/` do Lucas; o design system veio de
`plataforma-product-ops/src/design-system/`. `prompt-creator` e `security-check`
não existiam e foram escritas aqui.

## Decisão
O plugin é **downstream**: copia, adapta caminhos (`${CLAUDE_PLUGIN_ROOT}` em vez
de `~/.claude/skills/...`), remove o que é da máquina do Lucas (ram-guard M1,
vault Obsidian, whisper-agent) e registra a data do snapshot. Quem muda a fonte
atualiza o plugin e sobe `version` no `plugin.json`. Exceções — `prompt-creator`,
`security-check`, `stl-setup`, `stl-project-init` — nascem aqui e aqui é a fonte.

## Consequências
- Divergência é esperada e visível pelo `git log` do plugin, não um bug.
- `session-handoff` do plugin e a do Lucas têm o mesmo nome e semânticas
  diferentes (AD-003); na máquina do Lucas o plugin não deve ser instalado com a
  skill global ativa ao mesmo tempo, ou o modelo verá duas.
