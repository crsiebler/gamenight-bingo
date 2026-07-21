import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as themeExports from "../packages/themes/src/index.js";
import type { CatalogThemeId, ThemeDefinition } from "../packages/themes/src/index.js";

const EXPECTED_THEMES = [
  ["animals", "Animals"],
  ["nature", "Nature"],
  ["superheroes", "Superheroes"],
  ["pirates", "Pirates"],
  ["ghosts", "Ghosts"],
  ["sports", "Sports"],
  ["christmas", "Christmas"],
  ["halloween", "Halloween"],
  ["july-4th", "July 4th"],
  ["valentines-day", "Valentine's Day"],
  ["birthday", "Birthday"],
] as const;

const COLOR_SET_KEYS = ["background", "text", "border", "indicator"] as const;

type ColorSet = Record<(typeof COLOR_SET_KEYS)[number], string>;

type ThemeFixture = {
  id: string;
  name: string;
  visuals: ThemeDefinition["visuals"];
  moodboard: {
    atmosphere: string;
    motifs: readonly string[];
    paletteIntent: string;
    shapeLanguage: string;
    texture: string;
    motionCharacter: string;
    originalDirection: string;
    avoid: readonly string[];
  };
  tokens: {
    canvas: string;
    surface: string;
    surfaceInverse: string;
    surfaceElevated: string;
    border: string;
    text: {
      primary: string;
      secondary: string;
      inverse: string;
      link: string;
      danger: string;
    };
    focus: { inner: string; outer: string; widthPx: number; offsetPx: number };
    card: {
      surface: string;
      border: string;
      header: ColorSet;
      uncalled: ColorSet;
      called: ColorSet;
      marked: ColorSet;
      free: ColorSet;
      unavailable: ColorSet;
    };
    state: {
      neutral: ColorSet;
      info: ColorSet;
      success: ColorSet;
      warning: ColorSet;
      danger: ColorSet;
    };
    ball: { current: ColorSet; history: ColorSet };
    result: { checking: ColorSet; winner: ColorSet; otherWinner: ColorSet };
    motion: {
      stateTransitionMs: number;
      daubMs: number;
      celebrationMs: number;
    };
  };
};

type ThemeModule = {
  themeCatalog?: readonly ThemeFixture[];
  themeAccessibilityPolicy?: {
    highContrast: {
      prefersContrast: string;
      forcedColors: string;
      borderWidthPx: number;
      underlineLinks: boolean;
      removeDecorations: boolean;
      stateMarkers: readonly string[];
    };
    reducedMotion: {
      mediaQuery: string;
      transitionDurationMs: number;
      decorativeMotion: string;
      showFinalStateImmediately: boolean;
      preserveLiveAnnouncements: boolean;
    };
  };
  getTheme?: (id: string) => ThemeFixture | undefined;
  renderThemeMoodboardHtml?: () => string;
  renderThemeMoodboardMarkdown?: () => string;
  themeCssVariables?: (theme: ThemeFixture) => Readonly<Record<string, string>>;
};

const moduleUnderTest = themeExports as ThemeModule;

function parseHex(hex: string): [number, number, number] {
  expect(hex, `expected an opaque six-digit hex color, received ${hex}`).toMatch(/^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(hex: string): number {
  const channels = parseHex(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

function expectContrast(
  theme: ThemeFixture,
  label: string,
  foreground: string,
  background: string,
  minimum: number,
) {
  const ratio = contrastRatio(foreground, background);
  expect(
    ratio,
    `${theme.id} / ${label} expected ${minimum}:1, received ${ratio.toFixed(3)}:1`,
  ).toBeGreaterThanOrEqual(minimum);
}

function colorSets(theme: ThemeFixture): ReadonlyArray<readonly [string, ColorSet]> {
  return [
    ...Object.entries(theme.tokens.card)
      .filter((entry): entry is [string, ColorSet] => typeof entry[1] === "object")
      .map(([name, colors]) => [`card.${name}`, colors] as const),
    ...Object.entries(theme.tokens.state).map(
      ([name, colors]) => [`state.${name}`, colors] as const,
    ),
    ...Object.entries(theme.tokens.ball).map(([name, colors]) => [`ball.${name}`, colors] as const),
    ...Object.entries(theme.tokens.result).map(
      ([name, colors]) => [`result.${name}`, colors] as const,
    ),
  ];
}

function expectedCssVariables(theme: ThemeFixture): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {
    "--bingo-theme-canvas": theme.tokens.canvas,
    "--bingo-theme-surface": theme.tokens.surface,
    "--bingo-theme-surface-inverse": theme.tokens.surfaceInverse,
    "--bingo-theme-surface-elevated": theme.tokens.surfaceElevated,
    "--bingo-theme-border": theme.tokens.border,
    "--bingo-theme-text-primary": theme.tokens.text.primary,
    "--bingo-theme-text-secondary": theme.tokens.text.secondary,
    "--bingo-theme-text-inverse": theme.tokens.text.inverse,
    "--bingo-theme-text-link": theme.tokens.text.link,
    "--bingo-theme-text-danger": theme.tokens.text.danger,
    "--bingo-theme-focus-inner": theme.tokens.focus.inner,
    "--bingo-theme-focus-outer": theme.tokens.focus.outer,
    "--bingo-theme-focus-width": `${theme.tokens.focus.widthPx}px`,
    "--bingo-theme-focus-offset": `${theme.tokens.focus.offsetPx}px`,
    "--bingo-theme-card-surface": theme.tokens.card.surface,
    "--bingo-theme-card-border": theme.tokens.card.border,
    "--bingo-theme-motion-state": `${theme.tokens.motion.stateTransitionMs}ms`,
    "--bingo-theme-motion-daub": `${theme.tokens.motion.daubMs}ms`,
    "--bingo-theme-motion-celebration": `${theme.tokens.motion.celebrationMs}ms`,
  };
  for (const [groupName, group] of [
    ["card", theme.tokens.card],
    ["state", theme.tokens.state],
    ["ball", theme.tokens.ball],
    ["result", theme.tokens.result],
  ] as const) {
    for (const [roleName, value] of Object.entries(group)) {
      if (typeof value !== "object") continue;
      const cssRole = roleName.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      for (const key of COLOR_SET_KEYS) {
        variables[`--bingo-theme-${groupName}-${cssRole}-${key}`] = value[key];
      }
    }
  }
  return variables;
}

describe("theme catalog", () => {
  it("defines the exact approved themes in stable display order", () => {
    expect(Array.isArray(moduleUnderTest.themeCatalog)).toBe(true);
    const catalog = moduleUnderTest.themeCatalog ?? [];

    expect(catalog.map(({ id, name }) => [id, name])).toEqual(EXPECTED_THEMES);
    expect(new Set(catalog.map(({ id }) => id)).size).toBe(EXPECTED_THEMES.length);
    expect(moduleUnderTest.getTheme?.("nature")).toBe(catalog[1]);
    expect(moduleUnderTest.getTheme?.("unknown-theme")).toBeUndefined();
    expectTypeOf<CatalogThemeId>().toEqualTypeOf<(typeof EXPECTED_THEMES)[number][0]>();
  });

  it("gives every theme a complete original and respectful moodboard", () => {
    const catalog = moduleUnderTest.themeCatalog ?? [];

    for (const theme of catalog) {
      expect(theme.moodboard.atmosphere.length).toBeGreaterThan(20);
      expect(theme.moodboard.motifs.length).toBeGreaterThanOrEqual(3);
      expect(theme.moodboard.paletteIntent.length).toBeGreaterThan(20);
      expect(theme.moodboard.shapeLanguage.length).toBeGreaterThan(20);
      expect(theme.moodboard.texture.length).toBeGreaterThan(20);
      expect(theme.moodboard.motionCharacter.length).toBeGreaterThan(20);
      expect(theme.moodboard.originalDirection).toMatch(/original/i);
      expect(theme.moodboard.avoid.length).toBeGreaterThanOrEqual(3);
      expect(theme.moodboard.avoid.join(" ")).toMatch(/logo|character|mark|franchise/i);
    }
  });

  it("provides every semantic color and motion role without transparency", () => {
    const catalog = moduleUnderTest.themeCatalog ?? [];

    for (const theme of catalog) {
      const colors = [
        theme.tokens.canvas,
        theme.tokens.surface,
        theme.tokens.surfaceInverse,
        theme.tokens.surfaceElevated,
        theme.tokens.card.surface,
        theme.tokens.border,
        ...Object.values(theme.tokens.text),
        theme.tokens.focus.inner,
        theme.tokens.focus.outer,
        ...colorSets(theme).flatMap(([, set]) => COLOR_SET_KEYS.map((key) => set[key])),
      ];
      for (const color of colors) parseHex(color);

      expect(theme.tokens.focus.widthPx).toBeGreaterThanOrEqual(3);
      expect(theme.tokens.focus.offsetPx).toBeGreaterThanOrEqual(2);
      expect(theme.tokens.motion.stateTransitionMs).toBeGreaterThan(0);
      expect(theme.tokens.motion.daubMs).toBeGreaterThan(0);
      expect(theme.tokens.motion.celebrationMs).toBeGreaterThan(0);
    }
  });

  it("meets WCAG contrast for text, focus, component boundaries, and state indicators", () => {
    const catalog = moduleUnderTest.themeCatalog ?? [];

    for (const theme of catalog) {
      const { tokens } = theme;
      for (const [surfaceName, surface] of [
        ["canvas", tokens.canvas],
        ["surface", tokens.surface],
        ["surfaceElevated", tokens.surfaceElevated],
        ["card.surface", tokens.card.surface],
      ] as const) {
        expectContrast(theme, `text.primary/${surfaceName}`, tokens.text.primary, surface, 4.5);
        expectContrast(theme, `text.secondary/${surfaceName}`, tokens.text.secondary, surface, 4.5);
        expectContrast(theme, `text.link/${surfaceName}`, tokens.text.link, surface, 4.5);
        expectContrast(theme, `text.danger/${surfaceName}`, tokens.text.danger, surface, 4.5);
        expect(
          Math.max(
            contrastRatio(tokens.focus.inner, surface),
            contrastRatio(tokens.focus.outer, surface),
          ),
          `${theme.id} / focus/${surfaceName}`,
        ).toBeGreaterThanOrEqual(3);
      }

      expectContrast(
        theme,
        "text.inverse/surfaceInverse",
        tokens.text.inverse,
        tokens.surfaceInverse,
        4.5,
      );

      expectContrast(theme, "border/canvas", tokens.border, tokens.canvas, 3);
      expectContrast(theme, "border/surface", tokens.border, tokens.surface, 3);
      expectContrast(theme, "card.border/card.surface", tokens.card.border, tokens.card.surface, 3);
      expectContrast(theme, "focus.inner/outer", tokens.focus.inner, tokens.focus.outer, 3);

      for (const [label, set] of colorSets(theme)) {
        expect(Object.keys(set).sort(), `${theme.id} / ${label} keys`).toEqual(
          [...COLOR_SET_KEYS].sort(),
        );
        expectContrast(theme, `${label}.text`, set.text, set.background, 4.5);
        expectContrast(theme, `${label}.border`, set.border, set.background, 3);
        expectContrast(theme, `${label}.indicator`, set.indicator, set.background, 3);
      }
    }
  });

  it("defines explicit high-contrast and reduced-motion behavior", () => {
    expect(moduleUnderTest.themeAccessibilityPolicy).toEqual({
      highContrast: {
        prefersContrast: "more",
        forcedColors: "system-colors",
        borderWidthPx: 3,
        underlineLinks: true,
        removeDecorations: true,
        stateMarkers: ["text", "glyph", "border-style"],
      },
      reducedMotion: {
        mediaQuery: "prefers-reduced-motion: reduce",
        transitionDurationMs: 0,
        decorativeMotion: "none",
        showFinalStateImmediately: true,
        preserveLiveAnnouncements: true,
      },
    });
  });

  it("maps canonical tokens to stable CSS custom properties", () => {
    for (const theme of moduleUnderTest.themeCatalog ?? []) {
      expect(moduleUnderTest.themeCssVariables?.(theme)).toEqual(expectedCssVariables(theme));
    }
  });

  it("keeps generated review documents in parity with canonical data", () => {
    expect(typeof moduleUnderTest.renderThemeMoodboardMarkdown).toBe("function");
    expect(typeof moduleUnderTest.renderThemeMoodboardHtml).toBe("function");

    const markdown = readFileSync(new URL("../docs/theme-moodboards.md", import.meta.url), "utf8");
    const html = readFileSync(new URL("../docs/theme-moodboards.html", import.meta.url), "utf8");

    expect(markdown).toBe(moduleUnderTest.renderThemeMoodboardMarkdown?.());
    expect(html).toBe(moduleUnderTest.renderThemeMoodboardHtml?.());
    expect(html.match(/<article class="theme-card" data-theme-id=/g)).toHaveLength(
      EXPECTED_THEMES.length,
    );
    for (const specimen of [
      "Text primary",
      "Text secondary",
      "Text inverse",
      "Text link",
      "Text danger",
      "Card header",
      "Uncalled",
      "Called",
      "Marked",
      "Free",
      "Unavailable",
      "Neutral",
      "Information",
      "Connected",
      "Paused",
      "Offline",
      "Current ball",
      "History ball",
      "Checking",
      "You won",
      "Another player won",
    ]) {
      expect(html, specimen).toContain(`<strong>${specimen}</strong>`);
    }
    expect(html).not.toContain("<button");
    expect(html).toContain("@media (prefers-contrast: more)");
    expect(html).toContain("background-image: none !important");
    expect(html).toContain("@media (forced-colors: active)");
    expect(html).toContain("outline-color: Highlight");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("transition-duration: 0ms !important");
  });
});
