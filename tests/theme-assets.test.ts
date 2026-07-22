import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import * as themeExports from "../packages/themes/src/index.js";
import type { ThemeDefinition } from "../packages/themes/src/index.js";

const ASSET_ROLES = [
  "icon",
  "dauber",
  "call-ball",
  "card-decoration",
  "winner",
  "other-winner",
] as const;

type AssetRole = (typeof ASSET_ROLES)[number];

type ThemeAssetModule = {
  themeCatalog?: readonly ThemeDefinition[];
  themeAssetRoles?: readonly AssetRole[];
  renderThemeAssetGalleryHtml?: () => string;
  renderThemeSprite?: (theme: ThemeDefinition) => string;
  validateThemeSprite?: (sprite: string) => readonly string[];
};

const moduleUnderTest = themeExports as ThemeAssetModule;

describe("theme visual assets", () => {
  it("attaches every required visual role to each canonical theme", () => {
    expect(moduleUnderTest.themeAssetRoles).toEqual(ASSET_ROLES);

    const catalog = moduleUnderTest.themeCatalog ?? [];
    expect(catalog).toHaveLength(11);
    expect(new Set(catalog.map((theme) => theme.visuals.spriteUrl)).size).toBe(catalog.length);

    for (const theme of catalog) {
      expect(theme.visuals.spriteUrl).toBe(`/theme-assets/${theme.id}.svg`);
      expect(theme.visuals.motif.length).toBeGreaterThan(2);
      expect(Object.keys(theme.visuals.concepts).sort()).toEqual([...ASSET_ROLES].sort());
      for (const role of ASSET_ROLES) {
        expect(theme.visuals.concepts[role].length, `${theme.id} / ${role}`).toBeGreaterThan(12);
      }
    }
  });

  it("records the required original hero, ghost, pirate, and baseball concepts", () => {
    const catalog = moduleUnderTest.themeCatalog ?? [];
    const concept = (themeId: string, role: AssetRole) =>
      catalog.find(({ id }) => id === themeId)?.visuals.concepts[role];

    expect(concept("superheroes", "winner")).toMatch(/original generic hero swoop/i);
    expect(concept("ghosts", "icon")).toMatch(/friendly floating ghost/i);
    expect(concept("pirates", "winner")).toMatch(/cartoon.*cannon.*confetti/i);
    expect(concept("pirates", "other-winner")).toMatch(/plank.*treasure.*runway/i);
    expect(concept("sports", "other-winner")).toMatch(/baseball.*strike.*ball/i);

    for (const theme of catalog) {
      expect(Object.values(theme.visuals.concepts).join(" ")).not.toMatch(
        /punish|defeat|humiliat|loser|recognizable|franchise|team logo/i,
      );
    }
  });

  it("generates safe static per-theme sprites within the selected-theme budget", () => {
    expect(typeof moduleUnderTest.renderThemeSprite).toBe("function");
    expect(typeof moduleUnderTest.validateThemeSprite).toBe("function");
    if (
      moduleUnderTest.renderThemeSprite === undefined ||
      moduleUnderTest.validateThemeSprite === undefined
    ) {
      return;
    }

    for (const theme of moduleUnderTest.themeCatalog ?? []) {
      const sprite = moduleUnderTest.renderThemeSprite(theme);
      const committed = readFileSync(
        new URL(`../apps/web/public/theme-assets/${theme.id}.svg`, import.meta.url),
        "utf8",
      );

      expect(committed).toBe(sprite);
      expect(moduleUnderTest.validateThemeSprite(sprite)).toEqual([]);
      expect(sprite).toContain('viewBox="0 0 120 120"');
      for (const role of ASSET_ROLES) {
        expect(sprite).toContain(`<symbol id="${role}"`);
      }
      expect(sprite).not.toMatch(
        /<script|<foreignObject|<animate|<set\b|<image|<text|\son[a-z]+=|(?:href|src)=["'](?:https?:|\/\/)/i,
      );
      expect(gzipSync(sprite).byteLength, `${theme.id} gzip budget`).toBeLessThanOrEqual(500_000);
      expect(
        brotliCompressSync(sprite).byteLength,
        `${theme.id} Brotli budget`,
      ).toBeLessThanOrEqual(500_000);

      for (const unsafe of [
        sprite.replace("</svg>", '<style>@import url("https://example.com/art.css")</style></svg>'),
        sprite.replace("</svg>", '<a href="javascript:alert(1)"><path d="M0 0"/></a></svg>'),
        sprite.replace("</svg>", '<animate attributeName="opacity" dur="1s"/></svg>'),
        sprite.replace("</svg>", '<path d="M0 0" onload="alert(1)"/></svg>'),
        sprite.replace("</svg>", '<path d="M0 0"></svg>'),
      ]) {
        expect(moduleUnderTest.validateThemeSprite(unsafe), theme.id).not.toEqual([]);
      }
    }
  });

  it("matches independently reviewed goldens for every theme and visual role", () => {
    expect(typeof moduleUnderTest.renderThemeSprite).toBe("function");
    if (moduleUnderTest.renderThemeSprite === undefined) return;

    const expected = JSON.parse(
      readFileSync(new URL("./goldens/theme-assets.json", import.meta.url), "utf8"),
    ) as Record<string, Record<AssetRole, string>>;
    const actual = Object.fromEntries(
      (moduleUnderTest.themeCatalog ?? []).map((theme) => {
        const sprite = moduleUnderTest.renderThemeSprite?.(theme) ?? "";
        return [
          theme.id,
          Object.fromEntries(
            ASSET_ROLES.map((role) => {
              const symbol = new RegExp(`<symbol id="${role}"[\\s\\S]*?</symbol>`).exec(
                sprite,
              )?.[0];
              expect(symbol, `${theme.id} / ${role}`).toBeDefined();
              return [
                role,
                createHash("sha256")
                  .update(symbol ?? "")
                  .digest("hex"),
              ];
            }),
          ),
        ];
      }),
    );

    expect(actual).toEqual(expected);
  });

  it("keeps the generated asset review gallery in parity with canonical data", () => {
    expect(typeof moduleUnderTest.renderThemeAssetGalleryHtml).toBe("function");
    if (moduleUnderTest.renderThemeAssetGalleryHtml === undefined) return;

    const html = readFileSync(new URL("../docs/theme-assets.html", import.meta.url), "utf8");
    expect(html).toBe(moduleUnderTest.renderThemeAssetGalleryHtml());
    expect(html).toContain('<link rel="icon" href="data:,">');
    expect(html).toContain("Decorative assets unavailable");
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
    expect(html).toContain("@media (prefers-contrast: more)");
    expect(html).toContain("@media (forced-colors: active)");
    expect(html).toContain(
      "@media (min-width: 50rem) { .gallery { grid-template-columns: repeat(3, minmax(0, 1fr)); } }",
    );
    expect(html.match(/<img[^>]+data-sprite-preload/g)).toHaveLength(1);
    expect(html).toContain('src="../apps/web/public/theme-assets/animals.svg"');
    expect(html).not.toMatch(
      /<img[^>]+src=["'][^"']*(?:nature|superheroes|pirates|ghosts|sports|christmas|halloween|july-4th|valentines-day|birthday)/i,
    );
    expect(html.match(/revealLoadedSprite\(\);/g)).toHaveLength(2);
    expect(html).toContain('if (preload.getAttribute("src") !== nextSprite)');
  });
});
