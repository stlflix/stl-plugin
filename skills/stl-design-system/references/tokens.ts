/**
 * Design tokens — single source of truth for the platform UI.
 *
 * Neutrals were mandated by the Fase 01 PRD (RT09). Accent families were
 * MEASURED by pixel-sampling the visual references in docs/ui-reference/
 * (saturated-cluster anchors per hue family), then normalized for text/surface
 * usage. Do not eyeball new values — extend by measuring.
 *
 * Contrast pass: the dark ladder is measured on the Replit reference and the
 * semantic text steps were moved along lightness ONLY (hue and saturation kept)
 * until every text ⨯ surface pair clears WCAG AA. The values below are the
 * light theme; the dark theme lives in tokens.css and reaches Tailwind through
 * the CSS vars in `tailwindColors`.
 */

export const neutral = {
  canvas: "#fcfcfc", // the page itself — dark #171718, below the surfaces
  background: "#fdfdfd", // raised surface: card, dropdown, dialog
  subBg: "#ffffff", // columns/sections that group cards
  selected: "#ffffff", // selected/hover state
  ink: "#252525", // primary text — 15.1:1 on background
  muted: "#6e7074", // secondary text/icons — 4.96:1, AA (was #aeaeae, 2.2:1)
} as const;

export const brand = {
  primary: "#4169e1", // STLFLIX logo blue (mid)
  primaryDark: "#2e3f9e", // hover/pressed
} as const;

/**
 * Semantic states (LIGHT) — anchors measured on dash-ref-01 (Modulix), with the
 * `text` step darkened where the badge pair failed AA: a badge is text on its
 * own `soft` panel, so both `text ⨯ background` and `text ⨯ soft` must clear
 * 4.5:1. danger 4.00→5.35, warning 3.87→5.08, info 4.00→5.32 (on background).
 * Dark counterparts live in tokens.css (`.dark`).
 */
export const semantic = {
  success: { text: "#28674c", accent: "#2e9e6b", soft: "#e6f8ee" }, // anchors #28674c, #b4fade, #eefff8
  danger: { text: "#c92c42", accent: "#ea8593", soft: "#ffe9ec" }, // anchors #ea8593, #ffb2bb
  warning: { text: "#906710", accent: "#ffe280", soft: "#fff3d6" }, // anchors #ffe280, #ffe4b0
  info: { text: "#2a66d4", accent: "#93bffc", soft: "#e8f0fe" }, // anchors #93bffc, #7a9dd7
  purple: { text: "#6d3fb8", accent: "#c5bcf2", soft: "#efeafc" }, // "vulnerável" — anchor tag.purple #c5bcf2
} as const;

/**
 * AI gradient — anchors measured on dash-ref-02 (Brain AI). The ONE gradient
 * sanctioned outside the skeleton sheen, reserved for AI-facing surfaces.
 * Documented in the README since day one; materialized here by the Growth
 * module's CRO chat, its first consumer.
 */
export const aiGradient = {
  from: "#e5aeff",
  via: "#ff8fb6",
  to: "#ffbc97",
} as const;

/** Pastel tag palette — anchors measured on dash-ref-03 (Taskk). */
export const tag = {
  cyan: "#a2e1f5",
  blue: "#a3d0fc",
  purple: "#c5bcf2",
  amber: "#ffe7b2",
} as const;

/**
 * Categorical series palette — constant hex (a series color must not flip with
 * the theme, or the same category would change identity between light/dark).
 * Because it cannot flip, every entry has to clear 3:1 (WCAG 1.4.11, non-text
 * graphics) against BOTH light and dark `--background`. The four tuned entries
 * carry a 0.1 margin over the floor so a nudge to the surface — the light one
 * has already moved from #ffffff to #fdfdfd once — does not silently sink a
 * series below it. It is also why the palette is spelled out here instead of
 * pointing at `semantic`, whose text steps are tuned for light only. Consumed
 * by the chart primitives in `components/ui/`.
 */
export const chartPalette = [
  brand.primary, // #4169e1 blue     4.76 / 3.51
  "#d94f63", // red              3.93 / 4.26
  "#2e9e6b", // green            3.32 / 5.04
  "#a97913", // ochre            3.80 / 4.40
  "#8b5cf6", // violet           4.16 / 4.02
  "#279dbb", // cyan             3.12 / 5.37 (was #2aa7c7, 2.82 on light)
  "#c75fa4", // magenta          3.69 / 4.54
  "#5b6b7b", // slate            5.38 / 3.11
  "#c98017", // amber            3.14 / 5.34 (was #e8a13c, 2.19 on light)
  "#3f9d6e", // green 2          3.30 / 5.08
  "#7d4dd1", // deep purple      5.36 / 3.13
  "#5c90e8", // light blue       3.12 / 5.36 (was #93b5f0, 2.08 on light)
] as const;

export const radius = {
  card: "0.5rem", // rounded-lg surfaces (cards, tables, sections)
  field: "0.375rem", // rounded-md inputs/buttons/chips
  circle: "9999px", // avatars and status dots only
} as const;

/** Radius scale — reverse-engineered from Linear (4·6·8·12·16·24·32). */
export const radiusScale = {
  "4": "4px",
  "6": "6px",
  "8": "8px",
  "12": "12px",
  "16": "16px",
  "24": "24px",
  "32": "32px",
} as const;

/** Elevation — Linear shadow system. Values live in tokens.css so they flip
 *  with the `.dark` theme; here we reference the vars for Tailwind. */
export const elevation = {
  low: "var(--shadow-low)",
  medium: "var(--shadow-medium)",
  high: "var(--shadow-high)",
  card: "var(--shadow-card)",
  dialog: "var(--shadow-dialog)",
  "stack-low": "var(--shadow-stack-low)",
} as const;

/** Motion — Linear speeds + easing library. */
export const motion = {
  easing: {
    "out-quart": "cubic-bezier(0.165, 0.84, 0.44, 1)",
    "out-quint": "cubic-bezier(0.23, 1, 0.32, 1)",
    "out-expo": "cubic-bezier(0.19, 1, 0.22, 1)",
    "in-out-cubic": "cubic-bezier(0.645, 0.045, 0.355, 1)",
  },
  duration: { quick: "100ms", regular: "250ms" },
} as const;

/** Inter optical weights — Linear ships these, not 500/600/700. */
export const fontWeight = {
  medium: "510",
  semibold: "590",
  bold: "680",
} as const;

/**
 * Wraps a CSS var so Tailwind's `/opacity` modifier keeps working on it.
 * Tailwind 3.4 can only apply an alpha modifier to a colour it can parse — a
 * bare `var(--x)` makes it DROP the utility silently, which is why
 * `bg-ink/70` (the modal scrim) and `bg-danger/80` emitted nothing. The
 * `<alpha-value>` placeholder is substituted by Tailwind (`1` when no modifier
 * is given), so `color-mix` returns the colour untouched in the common case.
 */
const themed = (v: string) =>
  `color-mix(in srgb, var(${v}) calc(<alpha-value> * 100%), transparent)`;

/** Flattened map consumed by tailwind.config.ts.
 *  Neutrals AND semantics reference CSS vars so the `.dark` theme flips them
 *  app-wide with zero component edits — semantic hex used to be constant, which
 *  left `text-success` at 2.5:1 and `bg-danger-soft` as a pale block on the dark
 *  page. Brand stays constant hex (PRD RT11) and so do the pastel tags, which
 *  are filled chips carrying their own dark ink. */
export const tailwindColors = {
  canvas: themed("--canvas"),
  background: themed("--background"),
  "sub-bg": themed("--sub-bg"),
  selected: themed("--selected"),
  ink: themed("--ink"),
  muted: themed("--muted"),
  line: themed("--line"),
  "line-strong": themed("--line-strong"),
  primary: brand.primary,
  "primary-dark": brand.primaryDark,
  success: {
    DEFAULT: themed("--success"),
    accent: themed("--success-accent"),
    soft: themed("--success-soft"),
  },
  danger: {
    DEFAULT: themed("--danger"),
    accent: themed("--danger-accent"),
    soft: themed("--danger-soft"),
  },
  warning: {
    DEFAULT: themed("--warning"),
    accent: themed("--warning-accent"),
    soft: themed("--warning-soft"),
  },
  info: {
    DEFAULT: themed("--info"),
    accent: themed("--info-accent"),
    soft: themed("--info-soft"),
  },
  purple: {
    DEFAULT: themed("--purple"),
    accent: themed("--purple-accent"),
    soft: themed("--purple-soft"),
  },
  tag,
} as const;
