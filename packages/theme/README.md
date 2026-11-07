# Milton theme assets

`base.css` owns the shared Carbon Copy light/dark palette, typography, and basic controls.
The site forces light; the app follows the system. `contrast.test.ts` checks
text pairs, functional borders, and the two matching dark declarations.

Both products use the same paper-and-typewriter design language, defined once in `base.css`:

JetBrains Mono supplies headings and labels; Geist supplies body text and controls.
Square buttons and sheets, an offset sheet edge, and the muted manila cover bar
carry the office-paperwork treatment across both products.

- `--space-*` is a four-pixel spacing scale expressed in rems (the suffix counts
  quarter-rems). Use it for margins, padding and gaps; keep layout widths and
  breakpoints local to the page.
- `--text-caption`, `--text-small`, `--text-body`, `--text-lead`, `--text-subtitle` and `--text-title`
  define the everyday type scale. Caption text starts at 12px. Page, report,
  section and hero tokens provide fluid display sizes for their different roles.
- `--font-display` aliases the mono family for headings and branding; `--font-display-weight`
  uses its real regular weight. `--radius-button` keeps square buttons separate from rounded text fields.
- `--leading-*`, `--radius-*`, `--control-height`, `--touch-target` and
  `--shadow-sheet` keep rhythm, controls and surfaces consistent.
- `.eyebrow`, `.button`/`button`, `input`, `.sheet`, `.sheet-bar` and `.sheet-content`
  are reusable CSS pieces. A sheet owns `--sheet-padding`,
  including its mobile value, so its bar, title and body can share aligned edges.

Shared components use ordinary HTML classes, so Astro and Hono JSX consume the
same CSS without a client runtime or framework-specific wrapper library:

| Pattern     | Shared contract                                                                   | Consumer-owned behavior                                                     |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Actions     | `.action-row` supplies a wrapping flex row and standard gap.                      | Section margins and when actions stack or stretch.                          |
| Helper text | `.small-note` supplies muted, small text, including inside sheets.                | Position and margins; add `role="status"` only for an actual status update. |
| Text fields | `input` and `textarea` share borders, surface, padding, and inherited typography. | Labels, validation, field width, and textarea resizing.                     |
| Buttons     | `.button` or `button`, optionally `.secondary`.                                   | Link destinations, form actions, and labels.                                |
| Documents   | `.sheet`, `.sheet-bar`, `.sheet-content`.                                         | Document semantics and app-specific cover-sheet layout.                     |

Use a local class alongside these shared classes when positioning a component.
For example, the site's `class="access-note small-note"` sets its margin locally;
the app uses `class="small-note"` with its normal paragraph rhythm. Keep semantic
roles separate from presentation: the site's inline copy status should not
inherit the app's boxed status notices. App-only notices, form layout, and report
structure stay in `server/src/pages.css` until another consumer needs them.

The landing page owns its editorial grids and examples; `server/src/pages.css`
owns app layout and the TPS document's special title treatment. Neither should
redefine the shared palette, control appearance or sheet bar. Use existing tokens
before adding another size. Keep tokens in CSS.

The fonts in `public/fonts` are self-hosted, with their upstream licenses:

- `geist-latin-variable.woff2`: Geist, upright variable 100–900; body text and controls.
  One file serves regular and semibold.
- `jetbrains-mono-regular.woff2`: JetBrains Mono, upright 400; display headings,
  report titles, brand, labels and code. `--font-display` and `--font-mono` share
  this one file. `--font-display-weight` avoids synthesizing a heavier display face.

Geist source: https://fonts.gstatic.com/s/geist/v5/gyByhwUxId8gMEwcGFWNOITd.woff2
Their SIL Open Font Licenses are included beside the files. JetBrains source:
https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/webfonts/JetBrainsMono-Regular.woff2

The app serves this full JetBrains Mono master. The site serves a Latin subset,
`apps/site/fonts/jetbrains-mono-latin.woff2`, which its Astro config copies over the
same `/fonts/jetbrains-mono-regular.woff2` path, so the CSS, the preload and the
display behavior are unchanged. The subset keeps Latin-1, Latin Extended-A/B and
Additional (including Vietnamese), IPA, spacing modifiers and combining marks,
general punctuation, super/subscripts, currency and letterlike symbols, plus the
basic arrows `←`–`↙`, `− ∕ ∙ ∞ ≈ ≠ ≤ ≥` and `✓ ✕ ✗`. It keeps every OpenType
feature and the original hinting, metrics and glyph names; dropping the names
changes Chromium's small-size rasterization. Other symbols, Greek, Cyrillic, box
drawing and code-only glyphs fall back to the system monospace font. Its glyphs are
identical to the master's. It is the same OFL font, so the license above covers it.
After changing the master, regenerate it with FontTools 4.63 and Brotli
(`pip install "fonttools[woff]"`), from the repository root:

```sh
pyftsubset packages/theme/public/fonts/jetbrains-mono-regular.woff2 \
  --unicodes="U+0000-036F,U+1E00-1EFF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2190-2199,U+2212,U+2215,U+2219,U+221E,U+2248,U+2260,U+2264-2265,U+2713,U+2715,U+2717,U+FEFF,U+FFFD" \
  --layout-features='*' --name-IDs='*' --name-languages='*' --name-legacy \
  --notdef-outline --glyph-names --flavor=woff2 \
  --output-file=apps/site/fonts/jetbrains-mono-latin.woff2
```

Both active faces use `font-display: optional`: if a font arrives too late,
keep the first rendered fallback for that visit instead of resizing visible text.
The landing layout preloads both faces. The server build and Astro config
copy the same assets into their public directories; no runtime font service is used.

`brand.ts` owns the plain folder navigation SVG and shared favicon links. The
Office Space-inspired printer favicon lives in `public/favicon.svg`, with an ICO
fallback containing transparent 16, 32, 48 and 64px renders of that SVG. Both builds
copy these same masters, so www, app and mcp serve identical icons. When editing
the SVG, regenerate the ICO frames and update the cache revision in `faviconLinks`.
App pages allow only same-origin images and fonts (`img-src 'self'`,
`font-src 'self'`); scripts and external images remain blocked.
`server/src/assets.ts` serves only the listed built asset paths from the server's
`public` directory. In production the app's Cloud Run service serves them through
`server/src/cloud-app.ts`; locally `server/scripts/dev.ts` does. Vercel serves only
the site's own copies.

### Instruction lists

Use `ul.instruction-list` for a set of working instructions in a report. It uses
plain outside bullets, a hanging indent, and shared compact spacing. Each `li`
must contain one complete instruction including its conditions and exceptions.
Do not derive instruction boundaries from blank lines in an opaque report, and
keep headings and empty-state messages outside the list. The class changes
presentation only; it does not rewrite stored text or the Markdown download.
