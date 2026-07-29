import {
  themeAudioRoles,
  themeCatalog,
  type ThemeAudioRole,
  type ThemeDefinition,
} from "./catalog.js";

const SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;
const TOTAL_SECONDS = 2.56;
const TARGET_RMS = 0.14;
const MAX_PEAK = 0.78;

function roleFrequencies(role: ThemeAudioRole, themeIndex: number): readonly number[] {
  const root = 220 + themeIndex * 13;
  switch (role) {
    case "call":
      return [root * 1.5, root * 2];
    case "daub":
      return [root * 0.75, root * 1.25];
    case "near-win":
      return [root, root * 1.25, root * 1.5];
    case "win":
      return [root, root * 1.25, root * 1.5, root * 2];
    case "other-winner":
      return [root, root * 1.2, root * 1.5];
  }
}

function renderCue(role: ThemeAudioRole, themeIndex: number, sampleCount: number): Float64Array {
  const frequencies = roleFrequencies(role, themeIndex);
  const samples = new Float64Array(sampleCount);
  const fadeSamples = Math.min(Math.round(SAMPLE_RATE * 0.025), Math.floor(sampleCount / 4));
  let squareTotal = 0;
  let peak = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / Math.max(1, sampleCount - 1);
    const fade = Math.min(1, index / fadeSamples, (sampleCount - 1 - index) / fadeSamples);
    const envelope = Math.max(0, fade) * (1 - progress * 0.35);
    const sample =
      (frequencies.reduce(
        (sum, frequency, harmonic) =>
          sum + Math.sin(2 * Math.PI * frequency * (index / SAMPLE_RATE)) / (harmonic + 1),
        0,
      ) /
        frequencies.length) *
      envelope;
    samples[index] = sample;
    squareTotal += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  const rms = Math.sqrt(squareTotal / sampleCount);
  const gain = Math.min(TARGET_RMS / rms, MAX_PEAK / peak);
  for (let index = 0; index < sampleCount; index += 1) samples[index] = samples[index]! * gain;
  samples[0] = 0;
  samples[sampleCount - 1] = 0;
  return samples;
}

export function renderThemeAudioSprite(theme: ThemeDefinition): Uint8Array {
  const themeIndex = themeCatalog.findIndex(({ id }) => id === theme.id);
  if (themeIndex < 0) throw new RangeError(`Unknown canonical theme: ${theme.id}`);
  const totalSamples = Math.round(TOTAL_SECONDS * SAMPLE_RATE);
  const pcm = new Int16Array(totalSamples);

  for (const role of themeAudioRoles) {
    const cue = theme.audio.cues[role];
    const start = Math.round(cue.offsetSeconds * SAMPLE_RATE);
    const sampleCount = Math.round(cue.durationSeconds * SAMPLE_RATE);
    const cueSamples = renderCue(role, themeIndex, sampleCount);
    for (let index = 0; index < cueSamples.length; index += 1) {
      pcm[start + index] = Math.round(cueSamples[index]! * 32_767);
    }
  }

  const bytes = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(bytes.buffer, HEADER_BYTES, pcm.length).set(pcm);
  return bytes;
}
