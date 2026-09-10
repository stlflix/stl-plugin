# Design System Audit — Gap + Linear Specs

Documento único. Reúne: (1) o **inventário de componentes faltantes** do projeto e
(2) as **specs reais medidas** no app do Linear (logado, `getComputedStyle` em
componentes renderizados) para servir de alvo de build. Não são estimativas.

- Fonte dos tokens: `docs/design-tokens-linear.md`
- Data da extração: 2026-07-22
- Espaço de cor do Linear: **`lch()`** (detalhe de ofício; nós mantemos hex/STLFLIX).

---

## 0. REGRAS DO SISTEMA (nível acima dos componentes)

Regras sistêmicas extraídas do Linear. Todo componente novo deve obedecer.

### Surface ladder (dark — medido em elementos reais)
`html #070707` (base/recesso) → `panel #0f1010` (conteúdo/topbar) →
`card #171718` (elevado) → `hover #1d1d1f`. Borda ≈ `white/0.08` (#1f2022).
Light: `#fff` → `#fafafa` → `#f7f7f7`. **Recesso = mais escuro** nos dois temas.

### Texto — 4 níveis, nunca hex solto
Light `#1b1b1b/#303032/#5d5d5f/#9e9ea1` · Dark `#fff/#e3e3e6/#97989a/#6a6b6d`.
Tokens: `--ink` (primário), `--muted` (terciário), `--text-*`.

### Pesos — ópticos do Inter, nunca 500/600/700
`400 · 510 (medium) · 590 (semibold) · 680 (bold)`. `font-feature-settings: "cv01","ss03"`.

### Densidade — Linear é COMPACTO
- Nav item: **h 34** (Linear 28) · radius **8** · weight 400/510 · ícone 16 muted.
- Ativo = só `bg-selected` (sem borda, sem bold, sem ícone colorido).
- Botão: **h 28** · radius 10 (secundário) / pill (primário) · pad `0 7–12`.
- Input/field: **h 36** · radius 6.
- List row 44 · group header 36 · segmented item 28/radius 5.

### Label de grupo (sidebar) — SEM uppercase
12px · weight 500 · cor muted · sem tracking. (Não `text-[10px] uppercase tracking-wide`.)

### Raio por contexto
field/input/kbd `6` · botão `10` · card/dropdown `8` · dialog `22` · pill/avatar `full`.

### Borda — sempre token theme-reactive
`border-line` (hairline) / `border-line-strong`. **Nunca** `border-black/[x]` (some no dark).

### Cor sobre superfície de cor fixa (pastel/soft)
Texto SEMPRE escuro fixo (`#1c1c1f`), nunca `text-ink` (vira branco no dark → ilegível).
Chips semânticos: soft claro no light; **translúcido do acento** (`accent/15`) no dark.

### Elevação — theme-reactive
Light: ring preto 0.5px + drop suave. Dark: **ring branco 0.5px + drop preto profundo**.
`shadow-card` (superfícies) · `shadow-dialog` (modais).

### Movimento
`duration-quick .1s` (hover/color) · `duration-regular .25s` (transform/layout) ·
`ease-out-quart`. Sempre `transition-colors`/`transition-transform`, nunca `transition` cru.

### UX — não usar
Alça de resize em textarea (auto-grow no lugar). Select nativo (usar dropdown do DS).

---

## 1. Estado atual do projeto

**14 primitivas** existentes:
`avatar · badge · button · card (+CardHeader/Section) · data-table (+TableCard) ·
dropdown-menu · icon-chip · kanban (board/column/card) · page-header ·
search-input · sparkline · stat-card · tabs · tag`

Dívidas estruturais detectadas:
- Forms = `<input>` crus inline repetidos em **4 views** (ProjectsView, SectorsView, UsersView, ProjectDetailView). Sem primitiva compartilhada.
- **1 modal ad-hoc** (`fixed inset-0`), sem portal, sem focus-trap, sem ESC.
- `⌘K` no `AppShell.tsx:216` é **decorativo** (só `<kbd>`, sem handler).
- `Kanban` 100% estático (sem drag & drop).
- Zero: `cmdk`, `framer-motion`, `Skeleton`, `Dialog`, `Tooltip`.

---

## 2. Componentes faltantes (~30 + 3 correções)

### 🔴 P0 — Forms
| Componente | Driver | Situação hoje |
|---|---|---|
| `Input` / `TextField` | todas as views | inline cru, 5+ cópias |
| `Textarea` | ProjectDetailView | 1 cópia inline |
| `FormField` (label + hint + error) | todos os forms | inexistente |
| `Select` (form) | ref-02 | dropdown-menu é de ação, não form |
| `Checkbox` | ref-01 (tabela) | 1 cópia inline |
| `Switch` / `Toggle` | settings/admin | inexistente |
| `Label` + `Kbd` | ref-02 (`⌘K`,`⌘J`) | kbd só inline |

### 🔴 P0 — Overlays
| Componente | Driver | Situação hoje |
|---|---|---|
| `Dialog` / `Modal` (portal + focus-trap + ESC) | criar/editar | modal ad-hoc sem portal |
| `Drawer` / `Sheet` (painel lateral) | Attio/Linear detail | inexistente |
| `CommandPalette` (`cmdk`) | ref-02, Linear | ⌘K é fake |
| `Tooltip` | Linear (hover hints) | inexistente |
| `Popover` | filtros/menus | inexistente |
| `ContextMenu` (right-click) | Linear/Taskk | inexistente |
| `Toast` c/ undo | Mercury/Linear | react-hot-toast cru |

### 🟠 P1 — Estados & feedback
| Componente | Driver | Situação hoje |
|---|---|---|
| `Skeleton` (shimmer) | Linear/Attio loading | usa `"—"` |
| `EmptyState` (ilustrado + CTA) | listas | texto inline |
| `Spinner` / `LoadingDots` | ações async | inexistente |
| `Alert` / `Banner` inline | erros de form | inexistente |
| `ProgressBar` / `ProgressRing` | ref-03 (% cards) | inexistente |

### 🟠 P1 — Data-viz & controles das refs
| Componente | Driver | Situação hoje |
|---|---|---|
| `BarChart` (Overview) | ref-01 | inexistente |
| `SortControl` + `FilterControl` | ref-02 | inexistente |
| `ViewSwitcher` (views nomeadas) | ref-02 | improviso c/ dropdown |
| `SegmentedControl` (Board/List/Timeline) | ref-03, Linear | `Tabs` cobre parcial |
| `Pagination` | tabelas | inexistente |
| `DatePicker` / `Calendar` | ref-01 (filtro data) | inexistente |
| `FilterChip` (removível) | ref-02 | `Tag` é só display |

### 🟡 P2 — Navegação & estrutura
| Componente | Driver | Situação hoje |
|---|---|---|
| `Breadcrumb` (standalone) | AppShell | hardcoded inline |
| `Divider` | layout | `border-t` solto repetido |
| `NavGroup` / `NavItem` | sidebar | lógica inline no AppShell |
| `AvatarGroup` (stacked) | ref-03 (assignees) | só `Avatar` single |

### ⚠️ Existem mas incompletos — corrigir
- `⌘K` (`AppShell.tsx:216`) → virar `CommandPalette` funcional.
- `Kanban` → adicionar drag & drop.
- Modal ad-hoc (`fixed inset-0`) → migrar para `Dialog`.

---

## 3. Specs REAIS do Linear (medidos no app logado)

Alvos de build. Valores em px salvo indicado. Cor original em `lch()`, aqui
traduzida para intenção.

### Button
- altura **28px** · radius **10px** · padding **0 7px** · gap **6px** (ícone↔label)
- font-size **13px** · weight 400 · transition **`all`**

### Nav item (sidebar)
- altura **28px** · radius **8px** · transition **`color .15s`**
- **ativo**: fill sutil elevado (`lch(10.82 1.35 272)` no dark ≈ `#1a1a1c`) — no nosso light usar `--selected`/`bg-selected`
- inativo: transparente, texto terciário

### Command Palette (⌘K) — o P0 principal
- **shell**: radius **12px** · elevação **`--shadow-high`** (`0 7px 32px #00000059`)
- **input**: altura **40px** · padding **11px 12px** · font-size **13px** · weight 400
- **hint à direita** do input: "Ask Linear · Tab"
- **grupos** (Issues/Projects/Documents/Views): label font-size **12px** · weight **500** · cor terciária · padding **8px 12px**
- **item**: altura **46px** · padding **0 12px** · font-size **15px** · gap **12px** (ícone↔label) · atalho alinhado à direita
- **item selecionado**: fill sutil (highlight), sem borda
- **atalho/kbd**: ~20×21px · font-size **13px**

### Segmented control (Active / Backlog / All issues)
- item altura **28px** · radius **5px** · ativo com fill sutil

### List row (Issues)
- altura **44px** · estrutura: `id · status-icon · título · [spacer] · avatar · data`
- sem borda entre rows (separação por espaçamento/hover)

### Group header (ex.: "Todo 4")
- altura **36px** · label + count · colapsável · `+` aparece no hover

### Kanban board (ref-03 real, board view do Linear)
- **coluna**: header `status-icon · nome · count · [...] · +` (menu e `+` no hover)
- **card**: largura ~**320px** · radius **8px** · padding **8px** · transition `all`
- **card shadow REAL de 3 camadas** (a elevação de produto, ≠ shadow-low do marketing):
  ```
  0 0 0 0.5px rgba(0,0,0,.08)     /* hairline ring   */
  0 4px 4px -1px rgba(0,0,0,.04)  /* soft drop       */
  0 1px 1px 0 rgba(0,0,0,.08)     /* contact shadow  */
  ```
- **estrutura do card**: `[id + avatar]` / `[status-icon + título]` / `[descrição …]` / `[Created <data>]`
- **id**: font-size **12px** · weight **450** · cor terciária
- **footer/data**: font-size **12px** · cor terciária
- **painel "Hidden columns"** (colunas vazias colapsadas à direita): item h**37px** · radius **8px** · fill sutil · `status-icon · nome · count`
- → nosso `Kanban` precisa: **drag & drop** + esta sombra + colapso de colunas vazias.

---

## 4. Ondas de execução recomendadas

1. **Onda P0-A (destrava tudo)**: `Input · Textarea · FormField · Select · Checkbox` → mata os 5+ inputs crus.
2. **Onda P0-B (salto "produto sério")**: `Dialog` (+ migrar modal ad-hoc) · `CommandPalette` real (mata o ⌘K fake) · `Tooltip`.
3. **Onda P1 (acabamento)**: `Skeleton · EmptyState · Spinner · ProgressRing · Toast c/ undo`.
4. **Onda P1-viz**: `SegmentedControl · SortControl · FilterControl · BarChart · FilterChip`.
5. **Onda P2 (limpeza)**: `Breadcrumb · Divider · NavGroup · AvatarGroup` + drag&drop no Kanban.

Todos os componentes já podem usar os tokens portados do Linear
(`shadow-{low,medium,high}`, `rounded-{4..32}`, `ease-out-quart`,
`duration-{quick,regular}`, `font-{medium=510,semibold=590,bold=680}`).

---

## 5. Entradas posteriores ao inventário

### Integração STLResearch (2026-07-29)

Primitivas trazidas do `ai-voice-survey` na integração do módulo STLResearch —
todas token-only, tema-reativas e presentes no showcase `/design`:

| Primitiva | Uso |
|---|---|
| `drawer` | Painel lateral direito (portal + backdrop + ESC + scroll-lock). Irmão do `Dialog` para superfícies de inspeção. |
| `audio-player` | Play/pause, seek e tempo; API controlável por ref para sincronizar com a transcrição. |
| `transcript-viewer` | Lista de turnos Q/A com highlight do turno ativo e clique-para-seek. |
| `sentiment-bar` | Barra de distribuição empilhada com legenda — genérica para qualquer split de 2+ segmentos. |

Correções e extensões nas primitivas existentes:
- `kanban` — **drag & drop horizontal de colunas** (fecha o item P2 da Onda 5), opt-in
  via `columnIds` + `onColumnReorder` + `sortableId` por coluna; sem essas props o
  board renderiza exatamente como antes. Colunas sem `sortableId` ficam fixas.
  Dot aceita cor crua (`dotColor`) para dados vindos do banco. Dep: `@dnd-kit/*`.
- `card` — `Section` ganhou `bordered` (false = superfície plana, usada pelas colunas do kanban).
- `dialog` — o efeito de ESC/scroll-lock voltou a ser keyed só em `open`; reexecutar a
  cada identidade nova de `onClose` roubava o foco de campos de formulário dentro do modal.
