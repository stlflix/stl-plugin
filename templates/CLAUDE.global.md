<!--
  STLFLIX — default global CLAUDE.md, installed by /stl-plugin:stl-setup.
  DRAFT: Lucas edits this file in the stl-plugin repo; collaborators receive it as-is.
  {{PROJETOS}} is replaced by the path the collaborator picked during setup.
-->

# STLFLIX — regras globais de desenvolvimento

Pasta de projetos: `{{PROJETOS}}`. Todo repositório STLFLIX vive aí; a configuração
do processo está em `~/.claude/stl/config.json`.

## 1. Higiene epistêmica (zero alucinação)
- **Verifique antes de agir.** Nunca adivinhe o estado do código: leia o arquivo
  (`cat`, `ls`, `grep -rn`) antes de propor mudança.
- "Eu acho que funciona" é inaceitável. "Eu testei e validei" é o padrão.
- Biblioteca nova ou erro obscuro: pare e pesquise (MCP `firecrawl` para web,
  `context7` para API de biblioteca) antes de gerar código repetidamente errado.

## 2. Autonomia e ferramentas
- **Debug proativo:** erro de build ou de API → investigue a documentação oficial
  via MCP antes de responder.
- **Self-healing obrigatório:** alterou arquivo → rode a skill `green-gate`
  (typecheck, lint, testes) e conserte o próprio erro antes de avisar que terminou.
- **Busca na internet: só `firecrawl`.** WebSearch/WebFetch não são o padrão.
- GitHub e Vercel entram pelos MCPs do plugin (OAuth via `/mcp`); Supabase
  self-hosted entra pela CLI `supabase`, nunca por chave colada em prompt.

## 3. Comunicação (zero enrolação)
- **Idioma híbrido:** conversa em Português do Brasil; código, variáveis, logs,
  commits e identificadores estritamente em Inglês.
- Proibido preenchimento ("Aqui está o código", "Espero que ajude", "Vou fazer").
- Responda com a ação tomada, o diff ou a resposta direta.

## 4. Qualidade de código
- **Escopo estrito:** altere só o necessário. Sem refatoração não solicitada.
- **Fail-fast:** proibido `try/catch` vazio; exceção propaga ou é logada com contexto.
- **Early returns**, sem aninhamento profundo.
- **Tipagem paranoica:** proibido `any`; entrada externa valida com Zod/Pydantic.

## 5. Onde mora o conhecimento (por projeto)
- `CLAUDE.md` do projeto — regras e comandos daquele repo (criado por
  `/stl-plugin:stl-project-init`).
- `docs/decisions/NNN-slug.md` — uma decisão por arquivo, numeração linear. **Não há
  índice**: `ls docs/decisions/` é o índice, `head -6` dá título/status/data.
  Escreva o AD **antes** de declarar a tarefa pronta.
- `docs/handoff/NNN-YYYY-MM-DD-slug.md` — um arquivo por sessão, linear, nunca
  sobrescrito (skill `session-handoff`). Ao começar, leia o de número mais alto.

## 6. Processo de entrega (as skills do plugin, nesta ordem)
1. `prompt-creator` — pedido vago vira prompt estruturado antes de começar.
2. `tlc-spec-driven` — feature não trivial passa por Specify → Design → Tasks → Execute.
3. `smart-dispatch` — roteie subtarefas para o modelo certo; um processo pesado por vez.
4. `green-gate` — nada é "pronto" com o gate vermelho.
5. `security-check` — auditoria do diff antes de todo merge.
6. `atomic-commit` — um commit por mudança lógica, Conventional Commits em inglês.
7. `session-handoff` — antes de `/clear`, `/compact` ou fechar o dia.

## 7. Git
- **Nunca trabalhe direto na `main`.** Toda tarefa abre `<tipo>/<slug-kebab>` a partir
  da `main` atualizada. Só commite quando a tarefa implicar ou for pedido.
- Conventional Commits rigoroso: `feat(api): add webhook parsing`.
- Merge só com o gate verde na branch **e** na `main` depois de mesclar;
  `git merge --no-ff` sempre. Fechar = mesclar, `push` e apagar a branch dos dois lados.
- Segredo nunca entra no repo: `.env*` está no `.gitignore` padrão e o
  `security-check` bloqueia o commit se encontrar chave.
