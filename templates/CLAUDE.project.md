# CLAUDE.md — {{PROJECT_NAME}}

> Regras específicas deste repositório. Herdam o `~/.claude/CLAUDE.md` global (STLFLIX).
> Mantenha enxuto: o que é específico de um módulo vive no `CLAUDE.md` daquele módulo.

## O que é
{{PROJECT_DESCRIPTION}}

## Stack
{{STACK}}

## Comandos
```bash
{{COMMANDS}}
```
Gate (`green-gate`): {{GATE}}

## Deploy e serviços
{{DEPLOY}}

## Onde mora o conhecimento
- `docs/decisions/NNN-slug.md` — decisões de arquitetura, uma por arquivo, linear.
  `ls docs/decisions/` é o índice; `head -6 docs/decisions/*.md` dá título/status/data.
- `docs/handoff/NNN-YYYY-MM-DD-slug.md` — handoff por sessão, linear, nunca sobrescrito.
  Ao começar uma sessão, leia o de número mais alto.
- `.specs/features/<slug>/` — artefatos do `tlc-spec-driven` (spec, design, tasks, validation).

## Regras de dev (além do global)
- Escopo estrito; sem refatoração não solicitada.
- Código, logs, identificadores e commits em **inglês**; comentários no estilo do arquivo vizinho.
- Não commite `.env*`, chaves ou dumps — `security-check` antes de todo merge.
{{EXTRA_RULES}}
