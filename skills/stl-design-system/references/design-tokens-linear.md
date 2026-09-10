# Linear — Design Tokens (reverse-engineered)

Extraído de `linear.app` via `getComputedStyle(document.documentElement)`.
Os CSS custom properties expostos no `:root` **são** o design system do Linear.
Valores reais, não estimados. Data: 2026-07-22.

## Typography
- **Family**: `"Inter Variable", "SF Pro Display", -apple-system, …` → adotar **Inter**.
- **Feature settings**: `"cv01", "ss03"` + `font-optical-sizing: auto` (`"opsz" auto`).
- **Optical weights** (não são 500/600/700): `light 300`, `normal 400`, `medium 510`, `semibold 590`, `bold 680`.
- **Sizes** (rem): micro `.6875` · tiny `.625` · small `.8125` (13px) · regular `.9375` (15px) · large `1.0625` (17px) · title2 `1.5` · title1 `2.25`.
- **Titles letter-spacing**: negativo (`-.012em` no title-3), tightening progressivo.

## Radius
`4 · 6 · 8 · 12 · 16 · 24 · 32`px, full `9999`, circle `50%`. Editor block `6px`.

## Shadows (alpha preto — funcionam em light mode)
- `--shadow-tiny`: `0 0 0 transparent`
- `--shadow-low`: `0px 2px 4px #0000001a`
- `--shadow-medium`: `0px 4px 24px #0003`
- `--shadow-high`: `0px 7px 32px #00000059`
- `--shadow-stack-low`: `0px 8px 2px 0px #0000, 0px 5px 2px 0px #00000003, 0px 3px 2px 0px #0000000a, 0px 1px 1px 0px #00000012, 0px 0px 1px 0px #00000014`

## Motion
- **Speeds**: quick `.1s` · regular `.25s` · highlightFadeOut `.15s`.
- **Easings** (biblioteca completa cubic-bezier):
  - out-quad `(.25,.46,.45,.94)`
  - out-quart `(.165,.84,.44,1)`
  - out-quint `(.23,1,.32,1)`
  - out-expo `(.19,1,.22,1)`
  - out-circ `(.075,.82,.165,1)`
  - in-out-cubic `(.645,.045,.355,1)`
  - in-out-quart `(.77,0,.175,1)`
  - in-out-quint `(.86,0,.07,1)`

## Neutrals / hierarchy (dark theme — usar só como *estrutura* de hierarquia)
- Text: primary `#f7f8f8` · secondary `#d0d6e0` · tertiary `#8a8f98` · quaternary `#62666d` (4 níveis).
- Border: **hairline `.5px`** (assinatura Linear), translucent `#ffffff0d`, strong `#ffffff14`.
- Accent (brand Linear): `#7170ff`, hover `#828fff`. → no nosso projeto mantemos o azul STLFLIX.

## Aplicação no projeto (light mode)
- Shadows/easing/speed/radius/type/weights → portados 1:1 (são neutros de tema).
- Hierarquia de texto de 4 níveis → mapeada para grays claros.
- Border hairline `.5px` translucent preto → `#0000000d`.
- Cor de marca permanece STLFLIX (`#4169e1`), não o roxo do Linear.
