import type { ThemeColorSet, ThemeDefinition } from "./catalog.js";
import { themeAccessibilityPolicy, themeCatalog } from "./catalog.js";

function setVariables(prefix: string, value: ThemeColorSet): Record<string, string> {
  return {
    [`${prefix}-background`]: value.background,
    [`${prefix}-text`]: value.text,
    [`${prefix}-border`]: value.border,
    [`${prefix}-indicator`]: value.indicator,
  };
}

export function themeCssVariables(theme: ThemeDefinition): Readonly<Record<string, string>> {
  const { tokens } = theme;
  return {
    "--bingo-theme-canvas": tokens.canvas,
    "--bingo-theme-surface": tokens.surface,
    "--bingo-theme-surface-inverse": tokens.surfaceInverse,
    "--bingo-theme-surface-elevated": tokens.surfaceElevated,
    "--bingo-theme-border": tokens.border,
    "--bingo-theme-text-primary": tokens.text.primary,
    "--bingo-theme-text-secondary": tokens.text.secondary,
    "--bingo-theme-text-inverse": tokens.text.inverse,
    "--bingo-theme-text-link": tokens.text.link,
    "--bingo-theme-text-danger": tokens.text.danger,
    "--bingo-theme-focus-inner": tokens.focus.inner,
    "--bingo-theme-focus-outer": tokens.focus.outer,
    "--bingo-theme-focus-width": `${tokens.focus.widthPx}px`,
    "--bingo-theme-focus-offset": `${tokens.focus.offsetPx}px`,
    "--bingo-theme-card-surface": tokens.card.surface,
    "--bingo-theme-card-border": tokens.card.border,
    ...setVariables("--bingo-theme-card-header", tokens.card.header),
    ...setVariables("--bingo-theme-card-uncalled", tokens.card.uncalled),
    ...setVariables("--bingo-theme-card-called", tokens.card.called),
    ...setVariables("--bingo-theme-card-marked", tokens.card.marked),
    ...setVariables("--bingo-theme-card-free", tokens.card.free),
    ...setVariables("--bingo-theme-card-unavailable", tokens.card.unavailable),
    ...setVariables("--bingo-theme-state-neutral", tokens.state.neutral),
    ...setVariables("--bingo-theme-state-info", tokens.state.info),
    ...setVariables("--bingo-theme-state-success", tokens.state.success),
    ...setVariables("--bingo-theme-state-warning", tokens.state.warning),
    ...setVariables("--bingo-theme-state-danger", tokens.state.danger),
    ...setVariables("--bingo-theme-ball-current", tokens.ball.current),
    ...setVariables("--bingo-theme-ball-history", tokens.ball.history),
    ...setVariables("--bingo-theme-result-checking", tokens.result.checking),
    ...setVariables("--bingo-theme-result-winner", tokens.result.winner),
    ...setVariables("--bingo-theme-result-other-winner", tokens.result.otherWinner),
    "--bingo-theme-motion-state": `${tokens.motion.stateTransitionMs}ms`,
    "--bingo-theme-motion-daub": `${tokens.motion.daubMs}ms`,
    "--bingo-theme-motion-celebration": `${tokens.motion.celebrationMs}ms`,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function styleAttribute(theme: ThemeDefinition): string {
  return Object.entries(themeCssVariables(theme))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

function renderColorSet(label: string, className: string): string {
  return `<div class="specimen ${className}"><span aria-hidden="true">●</span><strong>${label}</strong><small>Text + glyph + border</small></div>`;
}

function renderThemeCard(theme: ThemeDefinition): string {
  return `<article class="theme-card" data-theme-id="${theme.id}" style="${styleAttribute(theme)}">
  <header>
    <p class="kicker">${escapeHtml(theme.moodboard.atmosphere)}</p>
    <h2>${escapeHtml(theme.name)}</h2>
    <p>${escapeHtml(theme.moodboard.paletteIntent)}</p>
  </header>
  <div class="theme-grid">
    <section aria-labelledby="${theme.id}-card">
      <h3 id="${theme.id}-card">Card states</h3>
      <div class="bingo-preview card-token-panel" aria-label="Card state token preview">
        ${renderColorSet("Card header", "card-header")}
        ${renderColorSet("Uncalled", "card-uncalled")}
        ${renderColorSet("Called", "card-called")}
        ${renderColorSet("Marked", "card-marked")}
        ${renderColorSet("Free", "card-free")}
        ${renderColorSet("Unavailable", "card-unavailable")}
      </div>
    </section>
    <section aria-labelledby="${theme.id}-status">
      <h3 id="${theme.id}-status">Text, status, balls, and results</h3>
      <div class="token-row">
        ${renderColorSet("Text primary", "text-primary")}
        ${renderColorSet("Text secondary", "text-secondary")}
        ${renderColorSet("Text inverse", "text-inverse")}
        ${renderColorSet("Text link", "text-link")}
        ${renderColorSet("Text danger", "text-danger")}
        ${renderColorSet("Neutral", "state-neutral")}
        ${renderColorSet("Information", "state-info")}
        ${renderColorSet("Connected", "state-success")}
        ${renderColorSet("Paused", "state-warning")}
        ${renderColorSet("Offline", "state-danger")}
        ${renderColorSet("Current ball", "ball-current")}
        ${renderColorSet("History ball", "ball-history")}
        ${renderColorSet("Checking", "result-checking")}
        ${renderColorSet("You won", "result-winner")}
        ${renderColorSet("Another player won", "result-other")}
      </div>
    </section>
  </div>
  <details id="${theme.id}-direction">
    <summary>Moodboard direction</summary>
    <dl>
      <dt>Motifs</dt><dd>${theme.moodboard.motifs.map(escapeHtml).join(", ")}</dd>
      <dt>Shape language</dt><dd>${escapeHtml(theme.moodboard.shapeLanguage)}</dd>
      <dt>Texture</dt><dd>${escapeHtml(theme.moodboard.texture)}</dd>
      <dt>Motion</dt><dd>${escapeHtml(theme.moodboard.motionCharacter)}</dd>
      <dt>Original direction</dt><dd>${escapeHtml(theme.moodboard.originalDirection)}</dd>
      <dt>Avoid</dt><dd>${theme.moodboard.avoid.map(escapeHtml).join("; ")}</dd>
    </dl>
  </details>
</article>`;
}

export function renderThemeMoodboardMarkdown(): string {
  const themes = themeCatalog
    .map(
      (theme) => `## ${theme.name}

- **Atmosphere:** ${theme.moodboard.atmosphere}
- **Motifs:** ${theme.moodboard.motifs.join(", ")}
- **Palette intent:** ${theme.moodboard.paletteIntent}
- **Shape language:** ${theme.moodboard.shapeLanguage}
- **Texture:** ${theme.moodboard.texture}
- **Motion character:** ${theme.moodboard.motionCharacter}
- **Original direction:** ${theme.moodboard.originalDirection}
- **Avoid:** ${theme.moodboard.avoid.join("; ")}
`,
    )
    .join("\n");

  return `# GameNight Bingo Theme Moodboards

This document is generated from \`packages/themes/src/catalog.ts\`. The catalog is the canonical source for theme IDs, moodboards, and semantic tokens. Review the rendered [theme specimen gallery](./theme-moodboards.html) for every state.

## Shared Accessibility Direction

- Normal text token pairs meet at least WCAG 4.5:1; component boundaries, indicators, and focus treatments meet at least 3:1.
- Called, marked, unavailable, connection, pause, and result meaning always combines color with text, glyph, or border treatment.
- \`prefers-contrast: more\` removes decorative treatments, strengthens ${themeAccessibilityPolicy.highContrast.borderWidthPx}px borders, and underlines links.
- \`forced-colors: active\` uses system colors and preserves state labels, glyphs, and border styles.
- \`${themeAccessibilityPolicy.reducedMotion.mediaQuery}\` removes decorative motion, displays final state immediately, and preserves live announcements.
- Future art and sound must remain optional decoration; core play remains usable when an asset fails.

## Original And Respectful Direction

All theme work must be original and must not imitate protected characters, logos, team marks, official seals, catchphrases, costumes, fonts, or trade dress. Themes avoid cultural caricatures, gender assumptions, disability stereotypes, gore, militaristic victory framing, and hostile treatment of participants who did not win. Future asset work belongs to US-054 and must follow these constraints.

${themes}`;
}

export function renderThemeMoodboardHtml(): string {
  return `<!doctype html>
<!-- prettier-ignore -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GameNight Bingo theme moodboards</title>
  <style>
    * { box-sizing: border-box; }
    html { background: #eceff2; color: #17243a; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; }
    main { margin: 0 auto; max-width: 96rem; padding: clamp(1rem, 3vw, 3rem); }
    h1 { font-family: Georgia, serif; font-size: clamp(2.4rem, 8vw, 5rem); line-height: .95; margin: 0 0 1rem; max-width: 12ch; }
    .intro { font-size: 1.1rem; line-height: 1.6; max-width: 70ch; }
    .catalog { display: grid; gap: 1.5rem; margin-top: 2rem; }
    .theme-card { background: var(--bingo-theme-canvas); border: 3px solid var(--bingo-theme-border); border-radius: 1.25rem; color: var(--bingo-theme-text-primary); overflow: hidden; padding: clamp(1rem, 3vw, 2rem); }
    .theme-card > header { border-bottom: 3px solid var(--bingo-theme-border); margin-bottom: 1.25rem; padding-bottom: 1rem; }
    .theme-card h2 { font-family: Georgia, serif; font-size: clamp(2rem, 6vw, 3.5rem); line-height: 1; margin: .3rem 0 .75rem; }
    .theme-card h3 { margin: 0 0 .7rem; }
    .theme-card p { line-height: 1.5; }
    .kicker { color: var(--bingo-theme-text-secondary); font-size: .85rem; font-weight: 800; letter-spacing: .08em; margin: 0; text-transform: uppercase; }
    .theme-grid { display: grid; gap: 1.25rem; }
    .bingo-preview, .token-row { display: grid; gap: .65rem; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); }
    .card-token-panel { background: var(--bingo-theme-card-surface); border: 3px solid var(--bingo-theme-card-border); border-radius: 1rem; padding: .65rem; }
    .specimen { align-content: center; background: var(--set-background); border: 3px solid var(--set-border); border-radius: .75rem; color: var(--set-text); display: grid; gap: .2rem; min-height: 5.5rem; padding: .75rem; }
    .specimen span { color: var(--set-indicator); font-size: 1.25rem; line-height: 1; }
    .specimen small { font-weight: 700; }
    .text-primary { --set-background: var(--bingo-theme-surface); --set-text: var(--bingo-theme-text-primary); --set-border: var(--bingo-theme-border); --set-indicator: var(--bingo-theme-text-primary); }
    .text-secondary { --set-background: var(--bingo-theme-surface); --set-text: var(--bingo-theme-text-secondary); --set-border: var(--bingo-theme-border); --set-indicator: var(--bingo-theme-text-secondary); }
    .text-inverse { --set-background: var(--bingo-theme-surface-inverse); --set-text: var(--bingo-theme-text-inverse); --set-border: var(--bingo-theme-text-inverse); --set-indicator: var(--bingo-theme-text-inverse); }
    .text-link { --set-background: var(--bingo-theme-surface); --set-text: var(--bingo-theme-text-link); --set-border: var(--bingo-theme-border); --set-indicator: var(--bingo-theme-text-link); }
    .text-danger { --set-background: var(--bingo-theme-surface); --set-text: var(--bingo-theme-text-danger); --set-border: var(--bingo-theme-border); --set-indicator: var(--bingo-theme-text-danger); }
    .card-header { --set-background: var(--bingo-theme-card-header-background); --set-text: var(--bingo-theme-card-header-text); --set-border: var(--bingo-theme-card-header-border); --set-indicator: var(--bingo-theme-card-header-indicator); }
    .card-uncalled { --set-background: var(--bingo-theme-card-uncalled-background); --set-text: var(--bingo-theme-card-uncalled-text); --set-border: var(--bingo-theme-card-uncalled-border); --set-indicator: var(--bingo-theme-card-uncalled-indicator); }
    .card-called { --set-background: var(--bingo-theme-card-called-background); --set-text: var(--bingo-theme-card-called-text); --set-border: var(--bingo-theme-card-called-border); --set-indicator: var(--bingo-theme-card-called-indicator); border-style: double; }
    .card-marked { --set-background: var(--bingo-theme-card-marked-background); --set-text: var(--bingo-theme-card-marked-text); --set-border: var(--bingo-theme-card-marked-border); --set-indicator: var(--bingo-theme-card-marked-indicator); }
    .card-free { --set-background: var(--bingo-theme-card-free-background); --set-text: var(--bingo-theme-card-free-text); --set-border: var(--bingo-theme-card-free-border); --set-indicator: var(--bingo-theme-card-free-indicator); }
    .card-unavailable { --set-background: var(--bingo-theme-card-unavailable-background); --set-text: var(--bingo-theme-card-unavailable-text); --set-border: var(--bingo-theme-card-unavailable-border); --set-indicator: var(--bingo-theme-card-unavailable-indicator); border-style: dashed; }
    .state-neutral { --set-background: var(--bingo-theme-state-neutral-background); --set-text: var(--bingo-theme-state-neutral-text); --set-border: var(--bingo-theme-state-neutral-border); --set-indicator: var(--bingo-theme-state-neutral-indicator); }
    .state-info { --set-background: var(--bingo-theme-state-info-background); --set-text: var(--bingo-theme-state-info-text); --set-border: var(--bingo-theme-state-info-border); --set-indicator: var(--bingo-theme-state-info-indicator); }
    .state-success { --set-background: var(--bingo-theme-state-success-background); --set-text: var(--bingo-theme-state-success-text); --set-border: var(--bingo-theme-state-success-border); --set-indicator: var(--bingo-theme-state-success-indicator); }
    .state-warning { --set-background: var(--bingo-theme-state-warning-background); --set-text: var(--bingo-theme-state-warning-text); --set-border: var(--bingo-theme-state-warning-border); --set-indicator: var(--bingo-theme-state-warning-indicator); }
    .state-danger { --set-background: var(--bingo-theme-state-danger-background); --set-text: var(--bingo-theme-state-danger-text); --set-border: var(--bingo-theme-state-danger-border); --set-indicator: var(--bingo-theme-state-danger-indicator); }
    .ball-current { --set-background: var(--bingo-theme-ball-current-background); --set-text: var(--bingo-theme-ball-current-text); --set-border: var(--bingo-theme-ball-current-border); --set-indicator: var(--bingo-theme-ball-current-indicator); border-radius: 50%; text-align: center; }
    .ball-history { --set-background: var(--bingo-theme-ball-history-background); --set-text: var(--bingo-theme-ball-history-text); --set-border: var(--bingo-theme-ball-history-border); --set-indicator: var(--bingo-theme-ball-history-indicator); border-radius: 50%; text-align: center; }
    .result-checking { --set-background: var(--bingo-theme-result-checking-background); --set-text: var(--bingo-theme-result-checking-text); --set-border: var(--bingo-theme-result-checking-border); --set-indicator: var(--bingo-theme-result-checking-indicator); }
    .result-winner { --set-background: var(--bingo-theme-result-winner-background); --set-text: var(--bingo-theme-result-winner-text); --set-border: var(--bingo-theme-result-winner-border); --set-indicator: var(--bingo-theme-result-winner-indicator); }
    .result-other { --set-background: var(--bingo-theme-result-other-winner-background); --set-text: var(--bingo-theme-result-other-winner-text); --set-border: var(--bingo-theme-result-other-winner-border); --set-indicator: var(--bingo-theme-result-other-winner-indicator); }
    summary:focus-visible { outline: var(--bingo-theme-focus-width) solid var(--bingo-theme-focus-inner); outline-offset: var(--bingo-theme-focus-offset); box-shadow: 0 0 0 calc(var(--bingo-theme-focus-width) + var(--bingo-theme-focus-offset)) var(--bingo-theme-focus-outer); }
    details { background: var(--bingo-theme-surface); border: 3px solid var(--bingo-theme-border); border-radius: .75rem; margin-top: 1.25rem; padding: .75rem; }
    summary { cursor: pointer; font-weight: 800; min-height: 44px; padding: .6rem; }
    dl { display: grid; gap: .55rem; grid-template-columns: minmax(7rem, auto) 1fr; }
    dt { font-weight: 800; } dd { margin: 0; }
    @media (min-width: 56rem) { .catalog { grid-template-columns: repeat(2, minmax(0, 1fr)); } .theme-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (prefers-contrast: more) { *, *::before, *::after { background-image: none !important; } a { text-decoration: underline; } .specimen, details, .theme-card { border-width: ${themeAccessibilityPolicy.highContrast.borderWidthPx}px; } }
    @media (forced-colors: active) { .theme-card, .specimen, details { background: Canvas; border-color: CanvasText; color: CanvasText; } summary:focus-visible { box-shadow: none; outline-color: Highlight; } .card-called { border-style: double; } .card-unavailable { border-style: dashed; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0ms !important; } }
  </style>
</head>
<body>
  <main>
    <p class="kicker">Canonical design review</p>
    <h1>Theme moodboards</h1>
    <p class="intro">Eleven original visual directions share the same semantic roles. Color is always reinforced by text, glyph, and border treatment. Use Tab to review the two-tone focus treatment in every palette.</p>
    <div class="catalog">${themeCatalog.map(renderThemeCard).join("\n")}</div>
  </main>
</body>
</html>
`;
}
