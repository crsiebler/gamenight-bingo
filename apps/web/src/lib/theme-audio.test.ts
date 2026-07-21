import { describe, expect, it, vi } from "vitest";

import { themeCatalog, type ThemeDefinition } from "@gamenight-bingo/themes";

import * as webLib from "./index.js";

type AudioRole = "call" | "daub" | "near-win" | "win" | "other-winner";
type AudioSnapshot = {
  readonly status: "locked" | "loading" | "ready" | "unavailable";
  readonly muted: boolean;
  readonly volume: number;
};
type AudioBackend = {
  activate(): void | Promise<void>;
  load(url: string): Promise<void>;
  play(offsetSeconds: number, durationSeconds: number): void;
  setVolume(volume: number): void;
  stop(): void;
  dispose(): void;
};
type AudioController = {
  getSnapshot(): AudioSnapshot;
  subscribe(listener: () => void): () => void;
  enable(): Promise<void>;
  play(role: AudioRole, dedupeKey: string): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  dispose(): void;
};
type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
type ThemeAudioFactory = (
  theme: ThemeDefinition,
  options: {
    backendFactory: () => AudioBackend;
    storage?: StorageLike;
    storageFactory?: () => StorageLike;
  },
) => AudioController;

const createThemeAudioController = (
  webLib as unknown as {
    createThemeAudioController?: ThemeAudioFactory;
  }
).createThemeAudioController;

function setup(stored: string | null = null) {
  const calls: string[] = [];
  const backend: AudioBackend = {
    activate: vi.fn(() => {
      calls.push("activate");
    }),
    load: vi.fn(async (url) => {
      calls.push(`load:${url}`);
    }),
    play: vi.fn((offset, duration) => calls.push(`play:${offset}:${duration}`)),
    setVolume: vi.fn((volume) => calls.push(`volume:${volume}`)),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
    dispose: vi.fn(() => {
      calls.push("dispose");
    }),
  };
  const values = new Map<string, string>();
  if (stored !== null) values.set("gamenight-bingo.theme-audio.v1", stored);
  const storage: StorageLike = {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
  const theme = themeCatalog[0];
  if (theme === undefined || createThemeAudioController === undefined) {
    return { backend, calls, controller: undefined, storage };
  }
  return {
    backend,
    calls,
    controller: createThemeAudioController(theme, { backendFactory: () => backend, storage }),
    storage,
  };
}

describe("theme audio controller", () => {
  it("is available through the app library", () => {
    expect(typeof createThemeAudioController).toBe("function");
  });

  it("does no audio or network work before explicit enablement", async () => {
    const { backend, calls, controller } = setup();
    if (controller === undefined) return;

    expect(controller.getSnapshot()).toEqual({ status: "locked", muted: false, volume: 0.65 });
    controller.play("call", "call-1");
    expect(calls).toEqual([]);

    const enabling = controller.enable();
    expect(backend.activate).toHaveBeenCalledTimes(1);
    await enabling;
    expect(calls.slice(0, 2)).toEqual(["activate", "volume:0.65"]);
    expect(calls[2]).toBe("load:/theme-audio/animals.wav");
    expect(controller.getSnapshot().status).toBe("ready");
  });

  it("deduplicates cues, persists validated controls, and stops immediately when muted", async () => {
    const { backend, controller, storage } = setup();
    if (controller === undefined) return;
    await controller.enable();

    controller.play("daub", "mark-1");
    controller.play("daub", "mark-1");
    expect(backend.play).toHaveBeenCalledTimes(1);

    controller.setVolume(2);
    expect(controller.getSnapshot().volume).toBe(1);
    controller.setMuted(true);
    controller.play("win", "result-1");
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(backend.play).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenLastCalledWith(
      "gamenight-bingo.theme-audio.v1",
      JSON.stringify({ muted: true, volume: 1 }),
    );
  });

  it("consumes event identities while locked or muted so stale replays stay silent", async () => {
    const { backend, controller } = setup();
    if (controller === undefined) return;
    controller.play("call", "call-locked");
    await controller.enable();
    controller.play("call", "call-locked");
    expect(backend.play).not.toHaveBeenCalled();

    controller.setMuted(true);
    controller.play("near-win", "near-muted");
    controller.setMuted(false);
    controller.play("near-win", "near-muted");
    expect(backend.play).not.toHaveBeenCalled();
  });

  it("queues consecutive authoritative cues instead of truncating the first", async () => {
    vi.useFakeTimers();
    try {
      const { backend, controller } = setup();
      if (controller === undefined) return;
      await controller.enable();

      controller.play("daub", "mark-1");
      controller.play("near-win", "near-win-1");
      expect(backend.play).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(240);
      expect(backend.play).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores safe preferences without unlocking and fails without affecting gameplay", async () => {
    const { backend, controller } = setup(JSON.stringify({ muted: true, volume: 0.25 }));
    if (controller === undefined) return;
    expect(controller.getSnapshot()).toEqual({ status: "locked", muted: true, volume: 0.25 });

    vi.mocked(backend.load).mockRejectedValueOnce(new Error("decode failed"));
    await expect(controller.enable()).resolves.toBeUndefined();
    expect(controller.getSnapshot().status).toBe("unavailable");
    expect(() => controller.play("call", "call-1")).not.toThrow();
  });

  it("contains a synchronous browser activation failure", async () => {
    const { backend, controller } = setup();
    if (controller === undefined) return;
    vi.mocked(backend.activate).mockImplementationOnce(() => {
      throw new Error("AudioContext unavailable");
    });

    await expect(controller.enable()).resolves.toBeUndefined();
    expect(controller.getSnapshot().status).toBe("unavailable");
  });

  it("falls back to in-memory preferences when browser storage access is denied", () => {
    const theme = themeCatalog[0];
    expect(theme).toBeDefined();
    expect(createThemeAudioController).toBeDefined();
    if (theme === undefined || createThemeAudioController === undefined) return;
    const backend = setup().backend;

    expect(() =>
      createThemeAudioController(theme, {
        backendFactory: () => backend,
        storageFactory: () => {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    ).not.toThrow();
  });

  it("retries a transient load failure with a new backend", async () => {
    const theme = themeCatalog[0];
    expect(theme).toBeDefined();
    expect(createThemeAudioController).toBeDefined();
    if (theme === undefined || createThemeAudioController === undefined) return;
    const first = setup().backend;
    const second = setup().backend;
    vi.mocked(first.load).mockRejectedValueOnce(new Error("offline"));
    const backendFactory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const controller = createThemeAudioController(theme, { backendFactory });

    await controller.enable();
    expect(controller.getSnapshot().status).toBe("unavailable");
    await controller.enable();
    expect(controller.getSnapshot().status).toBe("ready");
    expect(backendFactory).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed persisted preferences and disposes active resources", async () => {
    const { backend, controller } = setup('{"muted":"yes","volume":9}');
    if (controller === undefined) return;
    expect(controller.getSnapshot()).toEqual({ status: "locked", muted: false, volume: 0.65 });
    await controller.enable();
    controller.dispose();
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(backend.dispose).toHaveBeenCalledTimes(1);
  });
});
