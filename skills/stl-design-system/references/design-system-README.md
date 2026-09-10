# Design System — Product Ops STLFLIX

Tokens e primitivos de UI da plataforma. Fonte da verdade: `tokens.ts` (importado
pelo `tailwind.config.ts`) e `tokens.css` (CSS custom properties). Showcase vivo
em **`/design`** com todos os primitivos renderizados.

## Referências visuais

As decisões vêm das três referências em `docs/ui-reference/` — cores de acento
**medidas por amostragem de pixels** (clusters saturados por família de matiz),
não estimadas a olho:

| Arquivo | Referência | O que fornece |
|---------|------------|---------------|
| `dash-ref-01.jpg` | Modulix (dashboard) | Stat cards, sparklines, badges semânticos (success/danger/warning/info), tabela com status, sidebar com subitens |
| `dash-ref-02.jpg` | Brain AI (tabela) | Toolbar de tabela, dropdown de views, gradiente "AI", sidebar com recents |
| `dash-ref-03.png` | Taskk (kanban) | Board com colunas `sub-bg` e cards brancos, tags pastel, tabs de visualização, botão primário escuro |

## Tokens

### Neutros (PRD RT09 — `background: #ffffff` mandatado)
| Token | Light | Dark | Uso |
|-------|-------|------|-----|
| `canvas` | `#fafafa` | `#171718` | **A página.** Só o `body` e o frame do AppShell |
| `background` | `#fdfdfd` | `#1c1c1d` | **Superfície elevada**: card, dropdown, dialog |
| `sub-bg` | `#ffffff` | `#121213` | Agrupa cards: sidebar, colunas e sections |
| `selected` | `#f5f3f3` | `#292a2b` | Selecionado/hover |
| `ink` | `#252525` | `#f2f3f3` | Texto principal — 15,1:1 / 15,3:1 |
| `muted` | `#6e7074` | `#a9aaae` | Texto secundário/ícones — 4,9:1 / 7,3:1 |
| `line` | `#404040/10,7%` | `white/8,4%` | Hairline — 1,19:1 / 1,27:1 |
| `line-strong` | `black/26%` | `white/22%` | Divisor forte — 1,89:1 / 2,05:1 |

A escada tem quatro degraus distintos nos dois temas, mas **a ordem não é a
mesma**. No dark ela sobe: recesso `#121213` → página `#171718` → superfície
`#1c1c1d` → hover `#292a2b`. No light ela foi afinada à mão e não segue: o card
(`#fdfdfd`) fica acima da página (`#f8f5f5`), mas o `sub-bg`, que agrupa cards,
é o MAIS claro dos quatro (`#ffffff`) em vez do recesso. Não
tente derivar um tema do outro; a direção é decisão de quem desenha, e o que o
teste cobra é que nenhum degrau colapse em cima de outro (AD-010).

O que era realmente quebrado, e continua consertado, é o dark: `canvas` e
`background` eram o **mesmo** token, então card, dropdown e página tinham a
mesma cor e a profundidade dependia só de uma borda de 8%.

O dark é **medido** na referência Replit (`docs/ui-reference/replit-dark.png`):
canvas `#1c1c1d`, superfície elevada `#212223`, sidebar `#1f1f20`, divisor
`#272829`, corpo `#e6e7e7`, muted `#a6a7aa`, placeholder `#7f8184`. A base saiu do
quase-preto (`#070707`/`#0f1010`) porque borda e elevação não tinham contra o que
ler. Cada degrau — recesso → painel → hover → hairline — é visível isolado.

### Marca (logo STLFLIX — PRD RT11)
`primary #4169e1` · `primary-dark #2e3f9e` · gradiente `#4f83ea → #2f3e9e`

### Semânticos (medidos em dash-ref-01)
Cada família tem `DEFAULT` (texto), `accent` (ícones/linhas) e `soft` (fundo de badge):
`success` (verde), `danger` (vermelho), `warning` (âmbar), `info` (azul), `purple`.
Âncoras medidas registradas em comentários no `tokens.ts`.

**Eles viram com o tema.** Um badge é `DEFAULT` sobre o próprio `soft`, então os dois
pares (`DEFAULT ⨯ background` e `DEFAULT ⨯ soft`) têm de passar AA. Como eram hex
constante, no dark o `text-success` ficava em 2,5:1 e o `bg-danger-soft` era um bloco
pálido no meio da página preta. Os valores dark saem do MESMO matiz e saturação do
âncora medido — só a luminosidade anda, até o par fechar 6,5:1.

| família | light `DEFAULT` | dark `DEFAULT` | dark `soft` |
|---|---|---|---|
| success | `#28674c` | `#54bd90` | `#0f2b1f` |
| danger | `#c92c42` | `#e58895` | `#33161b` |
| warning | `#906710` | `#e2a219` | `#33270e` |
| info | `#2a66d4` | `#88a9e7` | `#15243d` |
| purple | `#6d3fb8` | `#b39adc` | `#241d3d` |

`accent` e as tags pastel **não** viram: são preenchimentos que carregam a própria
tinta escura. `primary` também não — a marca é mandatada (RT11); em dark ele fica em
3,5:1 como texto, o que é o limite conhecido desta paleta.

Os tokens chegam ao Tailwind como `color-mix(... <alpha-value> ...)` e não como
`var(--x)` cru: o Tailwind 3.4 **descarta** a utility quando não consegue parsear a
cor, e era por isso que `bg-ink/70` (o scrim do modal) e `bg-danger/80` não emitiam
nada. Ao criar token novo, use o helper `themed()` do `tokens.ts`.

### Tags pastel (medidas em dash-ref-03)
`tag-cyan #a2e1f5` · `tag-blue #a3d0fc` · `tag-purple #c5bcf2` · `tag-amber #ffe7b2`
— sempre com texto `ink`.

### Gradiente AI (medido em dash-ref-02)
`#e5aeff → #ff8fb6 → #ffbc97` — `aiGradient` no `tokens.ts`, `--ai-from/via/to` e o
composto `--ai-gradient` no `tokens.css`. Reservado a superfícies de IA; o primeiro
consumidor é o Chat IA do módulo Growth. Único gradiente permitido além do sheen do
skeleton.

## Tipografia
**Manrope** (400–800) em toda a plataforma. Escala prática: títulos de página
`text-2xl font-bold`, seções `text-lg font-bold`, corpo `text-sm`, apoio
`text-xs text-muted`, labels de grupo `text-[11px] uppercase tracking-wider`.

## Raios e profundidade
Cards/tabelas/sections `rounded-lg` (8px) · campos/botões/badges/chips `rounded-md` (6px) ·
`rounded-full` reservado a avatares e dots de status. **Sem box-shadow** — a separação de
superfícies vem de bordas (`black/[0.07]`) e dos fundos `background`/`sub-bg`.

## Primitivos (`src/components/ui/`)
| Componente | Origem | Descrição |
|------------|--------|-----------|
| `Button` | ref-03 | `primary` (azul), `dark`, `outline`, `ghost` |
| `Badge` | ref-01 | Pill semântico (`success/danger/warning/info/purple/neutral/primary`) |
| `Tag` | ref-03 | Chip pastel (`cyan/blue/purple/amber`) |
| `Card` | ref-01/03 | Superfície branca `rounded-lg` com borda sutil |
| `Section` | ref-03 | Container `sub-bg` que agrupa cards |
| `StatCard` | ref-01 | Métrica com delta semântico e sparkline |
| `Sparkline` | ref-01 | Linha SVG de tendência |
| `Tabs` | ref-03 | Alternador de visualização; item aceita string ou `TabItem` (ícone + contador) |
| `SearchInput` | ref-01/02 | Busca com ícone |
| `DropdownMenu` | ref-02 | Menu flutuante com grupos e item ativo; `triggerClassName` deixa o gatilho virar aba, `panelWidthClassName` ajusta o painel, e ele sobe sozinho quando não cabe embaixo |
| `Select` | ref-02 | Combobox com painel **portado para o `<body>`** (fixed): nenhum `overflow` de ancestral o corta e nenhum header sticky pinta por cima; sobe quando não há espaço abaixo e cresce até 420px para não abreviar opção |
| `NumberInput` | — | Campo numérico com agrupamento pt-BR na tela (`1.234.567,89`) e valor cru na API (`1234567.89`); preserva o cursor ao reformatar |
| `Tooltip` | — | Chip por hover/foco; `wide` troca o chip por um painel que quebra linha, para explicação em vez de rótulo |
| `Dialog` | Linear | Modal com portal, ESC, scroll-lock e foco; `wide` para conteúdo que precisa da largura (preview de gráfico) |
| `DataTable` | ref-01/02 | Tabela genérica (header `sub-bg`, hover `selected`). Extensões opt-in: `elastic` numa coluna (as outras encolhem, a tabela nunca estoura o container), `freezable` + `maxHeight` (grade que rola dentro de si com colunas/linhas fixáveis por clique) e `onEdit` + `column.edit` (edição inline com dois cliques) |
| `KanbanBoard/Column/Card` | ref-03 | Board por colunas com contadores |
| `useFloatingPanel` | — | Regra única de painel flutuante: vira para cima quando não cabe embaixo e rola o ancestral até aparecer inteiro |

## Gráficos (`src/components/ui/`)
Primitivos **agnósticos de domínio**: não contam, não rotulam e não filtram nada.
Quem chama reduz suas linhas em `ChartEntry`/`ChartSeries`/`TrendPoint`
(`chart-types.ts`) e recebe de volta apenas o clique. É o que permite reusar o
mesmo gráfico em qualquer projeto do ecossistema.

| Componente | Descrição |
|------------|-----------|
| `ChartCard` | Casca do gráfico: título, contador, `ViewSwitcher`, corpo e descrição |
| `ViewSwitcher` | Segmented control compacto de visualização (`bar/pie/line/pills`) |
| `BarChart` | Barras horizontais com fill "fantasma" (`total`) sob o fill do filtro (`current`) |
| `PieChart` | Rosca + legenda clicável, cores do `chartPalette` |
| `LineChart` | Multi-série sobre um eixo de `ChartTick` |
| `PillGroup` | Pílulas selecionáveis para dimensões de baixa cardinalidade |
| `TrendChart` | Série temporal com dois eixos: contagem (barras/linha) + razão em % (linha vermelha) |
| `FilterChips` | Barra de filtros ativos, cada seleção como chip removível |
| `DateRangeCalendar` | Range picker restrito aos dias com dado |
| `useMeasure` | `ResizeObserver` para SVG responsivo |

Cross-filtering é convenção, não mágica: `total` é a contagem **ignorando o filtro
da própria dimensão** (fantasma) e `current` é a contagem sob o filtro inteiro.

## Scrollbars
Barra fina de trilho transparente e polegar translúcido (`--scrollbar-thumb` /
`--scrollbar-thumb-hover`, invertidos no tema escuro), aplicada globalmente em
`globals.css`. A utilitária `.scrollbar-hide` continua vencendo onde a barra tem
que sumir de vez.

## Regras
- Não introduza cor fora dos tokens; para nova cor, meça na referência e adicione ao `tokens.ts` + `tokens.css` + esta doc.
- Componentes novos entram em `src/components/ui/` e no showcase `/design`.
- Extensão de primitivo é **retrocompatível e opt-in**: `freezable`, `maxHeight`,
  `wide` e `triggerClassName` nasceram desligados justamente para que nenhuma tela
  existente mudasse de comportamento ao absorver um projeto.
