---
name: smart-dispatch
description: Roteia automaticamente as tarefas para o modelo Claude ideal (fable/opus/sonnet/haiku) com base na complexidade. Use ao implementar novas features, corrigir bugs ou em qualquer trabalho de desenvolvimento com múltiplas etapas.
---

# Roteamento Inteligente de Modelos (Smart Dispatch)

> Modelos atuais (família Claude 5 + 4.x): `fable` (Fable 5, tier Mythos — acima do Opus),
> `opus` (Opus 5), `sonnet` (Sonnet 5), `haiku` (Haiku 4.5).
> O parâmetro `model` do Agent tool aceita exatamente: `fable` | `opus` | `sonnet` | `haiku`.

## Regras de Roteamento de Modelos

### fable — Orquestração, arquitetura e decisões críticas
- Normalmente é o loop principal (você): planejar arquitetura, decompor a feature,
  revisar e integrar o trabalho dos subagentes.
- Delegue a um subagente `fable` apenas o que exigir raciocínio máximo isolado
  (ex.: auditoria de segurança profunda, design de contrato/migração de alto risco).
- Não delegue para `fable` o que `opus`/`sonnet` resolvem — é o tier mais caro.

### opus — Raciocínio complexo e regras de negócio difíceis
- Implementação de regras de negócio complexas ou algoritmos delicados
- Debug de problemas obscuros / race conditions
- Refatorações estruturais que atravessam vários módulos

### sonnet — Implementação padrão (o cavalo de trabalho)
- Lógica de negócios (casos de uso, repositórios, stores)
- Implementação de telas e componentes com estado/lógica
- Integrações de banco de dados e APIs, rotas, middlewares
- Portes/migrações com contrato claro e testes de paridade

### haiku — Tarefas rápidas e mecânicas
- Geração de arquivos de estilização (.styles.ts, .css, Tailwind)
- Criação e atualização de arquivos de tradução (i18n)
- Código repetitivo (boilerplate), fixtures e mocks
- Testes unitários padronizados a partir de um modelo/exemplo existente
- Renomeações, movimentações de arquivo e edições em massa determinísticas

## Como executar
Ao receber uma tarefa complexa, NÃO escreva todo o código sozinho.
Use o Agent tool especificando o parâmetro `model` para delegar aos tiers
mais baratos quando apropriado. Escreva prompts autocontidos (arquivos-alvo,
contrato, critérios de aceite) — o subagente não tem seu contexto.

⚠️ Máquina com pouca RAM (≤ 8 GB)? SERIALIZE os subagentes — um processo pesado
por vez, nunca fan-out paralelo; cada subagente é outro processo Claude Code.

Exemplo de plano para "Implementar a funcionalidade de Carrinho de Compras":
1. [Você/Fable] Planejar a arquitetura, o contrato e decompor em tarefas atômicas.
2. [Subagente/Sonnet] Implementar as camadas de domínio e dados.
3. [Subagente/Sonnet] Implementar a interface da tela e a integração com a API.
4. [Subagente/Haiku] Gerar estilos, chaves de tradução e mocks.
5. [Subagente/Haiku] Escrever os testes unitários baseados na implementação do Sonnet.
6. [Você/Fable] Revisar o diff integrado, rodar os gates e fechar.
