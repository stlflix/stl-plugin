# 001 — O repositório é o marketplace e o plugin ao mesmo tempo

**Status:** aceito · **Data:** 2026-09-09

## Contexto
Colaboradores instalam via `claude plugin marketplace add <owner>/<repo>`. Um
marketplace pode listar plugins em subpastas (`./plugins/x`) ou apontar `source`
para a própria raiz (`./`). Lucas pediu "uma pasta stl-plugin", um plugin só.

## Decisão
`stl-plugin/` é um repo próprio em `~/Projetos/stl-plugin` (não módulo da
plataforma-product-ops): `.claude-plugin/marketplace.json` (nome `stlflix`) lista um
único plugin com `source: "./"`, e `.claude-plugin/plugin.json` descreve esse plugin.
Id de instalação: `stl-plugin@stlflix`.

## Consequências
- Um `git clone` a menos para o colaborador; a plataforma não precisa ser acessível
  para instalar o processo.
- Se um segundo plugin STLFLIX nascer, ele entra como `./plugins/<nome>` no mesmo
  marketplace sem quebrar quem já instalou este.
- `CLAUDE.md` na raiz do plugin **não** é carregado pelo Claude Code; instrução
  para o modelo vive em `skills/`, e o CLAUDE.md global do colaborador vem de
  `templates/` via `stl-setup`.
