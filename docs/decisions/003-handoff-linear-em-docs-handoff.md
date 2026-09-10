# 003 — Handoff por sessão é linear em `docs/handoff/`, como as decisões

**Status:** aceito · **Data:** 2026-09-09

## Contexto
A skill `session-handoff` original grava um doc vivo por projeto no vault Obsidian
do Lucas e sobrescreve a cada sessão. Colaboradores não têm o vault, e vários
podem trabalhar no mesmo repo — um doc único seria atropelado.

## Decisão
Cada sessão **acrescenta** um arquivo `docs/handoff/NNN-YYYY-MM-DD-slug.md`,
numeração linear como `docs/decisions/NNN-slug.md`. Nada é sobrescrito; `ls` é o
índice; retomar = ler o de número mais alto. Decisão durável vai para
`docs/decisions/` e o handoff a referencia (proibido duplicar). O hook
`SessionStart` imprime o último handoff ao abrir o repo.

## Consequências
- Histórico completo versionado no repo; Lucas vê onde cada colaborador parou sem
  ferramenta externa.
- Sem estado global por máquina: o handoff mora onde o código mora.
- A pasta cresce um arquivo por sessão; se virar ruído, arquivar `docs/handoff/YYYY/`
  é uma decisão futura, não uma exceção desta regra.
