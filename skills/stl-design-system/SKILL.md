---
name: stl-design-system
description: The STLFLIX product-ops design system — tokens (neutrals, brand blue #4169e1, semantic families, pastel tags, AI gradient), typography (Inter, optical weights), radius/elevation rules, the primitive component catalogue and the rules for adding new ones. Use whenever building or reviewing UI for a STLFLIX product (Next.js + Tailwind): new screens, components, colors, charts, dark mode. Snapshot of plataforma-product-ops/src/design-system on 2026-09-09; the platform repo is the source of truth.
allowed-tools: Read, Grep, Glob
---

# stl-design-system — STLFLIX UI, one source of truth

**Source of truth**: `plataforma-product-ops/src/design-system/{tokens.ts,tokens.css,README.md}`
(+ live showcase at `/design`). This skill ships a **snapshot** (2026-09-09) in
`references/`. When you are inside the platform repo, read the real files instead.

## Non-negotiable rules
1. **No color outside the tokens.** New color → measure it on the reference image,
   add to `tokens.ts` + `tokens.css` + README, then use. Never eyeball a hex.
2. **Neutrals ladder** (light): `canvas #fcfcfc` page · `background #fdfdfd` raised
   surface (card/dropdown/dialog) · `sub-bg #ffffff` groups cards (sidebar, sections)
   · `selected` hover/selected · `ink #252525` text · `muted #6e7074` secondary ·
   `line` hairline · `line-strong` divider. Dark ladder lives in `tokens.css` (`.dark`)
   and is **not** derived from light — read it, don't invert.
3. **Brand**: `primary #4169e1` (STLFLIX blue), `primary-dark #2e3f9e`, gradient
   `#4f83ea → #2f3e9e`. Brand does not flip with theme.
4. **Semantic families** `success · danger · warning · info · purple`, each with
   `DEFAULT` (text), `accent` (icons/lines), `soft` (badge background). A badge is
   `DEFAULT` on its own `soft`; both pairs must clear WCAG AA — the test
   `tokens.contrast.test.ts` enforces it.
5. **Pastel tags** `tag-cyan #a2e1f5 · tag-blue #a3d0fc · tag-purple #c5bcf2 ·
   tag-amber #ffe7b2` — always with `ink` text.
6. **AI gradient** `#e5aeff → #ff8fb6 → #ffbc97` — the only gradient allowed besides
   the skeleton sheen; reserved for AI-facing surfaces.
7. **Typography**: **Inter** (`--font-inter`, `next/font/google` in `layout.tsx`) with
   Linear's optical weights — `400 · 510 medium · 590 semibold · 680 bold`
   (`fontWeight` in `tokens.ts`; never 500/600/700) and
   `font-feature-settings: "cv01","ss03"`. Scale: page title `text-2xl font-bold`,
   section `text-lg font-bold`, body `text-sm`, support `text-xs text-muted`, group
   labels `text-[11px] uppercase tracking-wider`. The README snapshot still says
   "Manrope" — the code is the truth.
8. **Radius**: cards/tables/sections `rounded-lg` (8) · fields/buttons/badges/chips
   `rounded-md` (6) · `rounded-full` only avatars and status dots.
9. **No box-shadow.** Depth comes from borders (`black/[0.07]`) and the
   `background`/`sub-bg` surfaces.
10. **Tailwind alpha**: tokens reach Tailwind through `color-mix(... <alpha-value>)`
    (helper `themed()` in `tokens.ts`). A raw `var(--x)` makes Tailwind 3.4 silently
    drop `bg-ink/70`. Use the helper for every new token.
11. **New primitives** go in `src/components/ui/` **and** in the `/design` showcase.
    Extending a primitive is opt-in and backwards compatible (`freezable`, `wide`,
    `triggerClassName` all default off).
12. **Charts are domain-agnostic**: they receive `ChartEntry`/`ChartSeries`/
    `TrendPoint` and return clicks. Counting/filtering belongs to the caller.

## Primitive catalogue (use before writing a new one)
`Button` (primary/dark/outline/ghost) · `Badge` · `Tag` · `Card` · `Section` ·
`StatCard` · `Sparkline` · `Tabs` · `SearchInput` · `DropdownMenu` · `Select`
(portaled to body) · `NumberInput` (pt-BR grouping) · `Tooltip` · `Dialog` ·
`DataTable` (elastic/freezable/inline edit) · `KanbanBoard/Column/Card` ·
`useFloatingPanel` · charts: `ChartCard` `ViewSwitcher` `BarChart` `PieChart`
`LineChart` `PillGroup` `TrendChart` `FilterChips` `DateRangeCalendar` `useMeasure`.

## References (read on demand, not by default)
- `references/design-system-README.md` — full token tables, dark values, catalogue with behaviours.
- `references/tokens.ts` / `references/tokens.css` — the actual values and the `themed()` helper.
- `references/design-system-audit.md` — Linear-measured component specs (density, nav sizes, surface ladder).
- `references/design-tokens-linear.md` — motion/easing/radius/shadow library we ported.

## Applying it in a project outside the platform
Copy `tokens.ts` + `tokens.css` verbatim, wire `tailwind.config.ts` as the platform
does (`colors: tailwindColors, borderRadius: radiusScale, ...`), import `tokens.css`
in `globals.css`, load Inter (`next/font/google`). Then the rules above apply unchanged. Diverging from
the tokens is a decision — write it in `docs/decisions/` of that project.
