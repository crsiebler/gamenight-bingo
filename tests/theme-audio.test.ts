import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as themeExports from "../packages/themes/src/index.js";
import type { ThemeDefinition } from "../packages/themes/src/index.js";

const AUDIO_ROLES = ["call", "daub", "near-win", "win", "other-winner"] as const;

type AudioRole = (typeof AUDIO_ROLES)[number];
type AudioTheme = ThemeDefinition & {
  readonly audio: {
    readonly spriteUrl: string;
    readonly provenance: {
      readonly author: string;
      readonly license: string;
      readonly source: string;
    };
    readonly cues: Readonly<
      Record<
        AudioRole,
        {
          readonly offsetSeconds: number;
          readonly durationSeconds: number;
          readonly concept: string;
        }
      >
    >;
  };
};

type ThemeAudioModule = {
  themeCatalog?: readonly AudioTheme[];
  themeAudioRoles?: readonly AudioRole[];
  renderThemeAudioSprite?: (theme: AudioTheme) => Uint8Array;
};

const moduleUnderTest = themeExports as unknown as ThemeAudioModule;

function wavSamples(bytes: Uint8Array): Int16Array {
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WAVE");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16_000);
  expect(view.getUint16(34, true)).toBe(16);
  return new Int16Array(
    bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + bytes.byteLength),
  );
}

describe("theme audio assets", () => {
  it("attaches every required original audio role to every canonical theme", () => {
    expect(moduleUnderTest.themeAudioRoles).toEqual(AUDIO_ROLES);
    const catalog = moduleUnderTest.themeCatalog ?? [];
    expect(catalog).toHaveLength(11);
    expect(new Set(catalog.map(({ audio }) => audio.spriteUrl)).size).toBe(11);

    for (const theme of catalog) {
      expect(theme.audio.spriteUrl).toBe(`/theme-audio/${theme.id}.wav`);
      expect(Object.keys(theme.audio.cues).sort()).toEqual([...AUDIO_ROLES].sort());
      expect(theme.audio.provenance).toEqual({
        author: "GameNight Bingo",
        license: "Project-original",
        source: "Procedurally generated from canonical theme metadata",
      });
      for (const role of AUDIO_ROLES) {
        expect(theme.audio.cues[role].concept, `${theme.id} / ${role}`).toMatch(/original/i);
      }
      expect(theme.audio.cues["other-winner"].concept).toMatch(/respectful|congratulat/i);
    }
  });

  it("generates committed mono PCM sprites with headroom and a consistent active level", () => {
    expect(typeof moduleUnderTest.renderThemeAudioSprite).toBe("function");
    if (moduleUnderTest.renderThemeAudioSprite === undefined) return;

    for (const theme of moduleUnderTest.themeCatalog ?? []) {
      const generated = moduleUnderTest.renderThemeAudioSprite(theme);
      const committed = new Uint8Array(
        readFileSync(new URL(`../apps/web/public/theme-audio/${theme.id}.wav`, import.meta.url)),
      );
      expect(committed).toEqual(generated);
      expect(generated.byteLength, `${theme.id} selected audio budget`).toBeLessThanOrEqual(
        1_000_000,
      );

      const samples = wavSamples(generated);
      for (const role of AUDIO_ROLES) {
        const cue = theme.audio.cues[role];
        const start = Math.round(cue.offsetSeconds * 16_000);
        const length = Math.round(cue.durationSeconds * 16_000);
        const cueSamples = samples.subarray(start, start + length);
        expect(cueSamples.length, `${theme.id} / ${role}`).toBeGreaterThan(1_000);
        expect(cueSamples[0]).toBe(0);
        expect(cueSamples.at(-1)).toBe(0);
        const normalized = Array.from(cueSamples, (sample) => sample / 32_768);
        const peak = Math.max(...normalized.map(Math.abs));
        const rms = Math.sqrt(
          normalized.reduce((total, sample) => total + sample * sample, 0) / normalized.length,
        );
        expect(peak, `${theme.id} / ${role} peak`).toBeLessThanOrEqual(0.8);
        expect(rms, `${theme.id} / ${role} rms`).toBeGreaterThanOrEqual(0.1);
        expect(rms, `${theme.id} / ${role} rms`).toBeLessThanOrEqual(0.2);
      }
    }
  });
});
