import type { ThemeAudioCue, ThemeAudioRole, ThemeDefinition } from "@gamenight-bingo/themes";

const STORAGE_KEY = "gamenight-bingo.theme-audio.v1";

export type ThemeAudioSnapshot = {
  readonly status: "locked" | "loading" | "ready" | "unavailable";
  readonly muted: boolean;
  readonly volume: number;
};

export type ThemeAudioBackend = {
  activate(): void | Promise<void>;
  load(url: string): Promise<void>;
  play(offsetSeconds: number, durationSeconds: number): void;
  setVolume(volume: number): void;
  stop(): void;
  dispose(): void;
};

export type ThemeAudioStorage = Pick<Storage, "getItem" | "setItem">;

type QueuedCue = {
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
};

export type ThemeAudioController = {
  getSnapshot(): ThemeAudioSnapshot;
  subscribe(listener: () => void): () => void;
  enable(): Promise<void>;
  play(role: ThemeAudioRole, dedupeKey: string): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  dispose(): void;
};

class BrowserThemeAudioBackend implements ThemeAudioBackend {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;

  activate(): Promise<void> | void {
    this.context ??= new AudioContext();
    this.gain ??= this.context.createGain();
    this.gain.connect(this.context.destination);
    if (this.context.state === "suspended") return this.context.resume();
  }

  async load(url: string): Promise<void> {
    if (this.context === null) throw new Error("Audio is not activated.");
    const response = await fetch(url, { cache: "force-cache", credentials: "same-origin" });
    if (!response.ok) throw new Error("Theme audio is unavailable.");
    this.buffer = await this.context.decodeAudioData(await response.arrayBuffer());
  }

  play(offsetSeconds: number, durationSeconds: number): void {
    if (this.context === null || this.gain === null || this.buffer === null) return;
    this.stop();
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    source.addEventListener("ended", () => {
      if (this.source === source) this.source = null;
    });
    source.start(0, offsetSeconds, durationSeconds);
    this.source = source;
  }

  setVolume(volume: number): void {
    if (this.gain !== null) this.gain.gain.value = volume;
  }

  stop(): void {
    try {
      this.source?.stop();
    } catch {
      // A source may already have ended; audio remains optional.
    }
    this.source = null;
  }

  dispose(): void {
    this.stop();
    if (this.context !== null) void this.context.close().catch(() => undefined);
    this.context = null;
    this.gain = null;
    this.buffer = null;
  }
}

function safePreferences(
  storage: ThemeAudioStorage | undefined,
): Pick<ThemeAudioSnapshot, "muted" | "volume"> {
  try {
    const stored = storage?.getItem(STORAGE_KEY);
    if (stored === null || stored === undefined) return { muted: false, volume: 0.65 };
    const parsed: unknown = JSON.parse(stored);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("muted" in parsed) ||
      typeof parsed.muted !== "boolean" ||
      !("volume" in parsed) ||
      typeof parsed.volume !== "number" ||
      !Number.isFinite(parsed.volume) ||
      parsed.volume < 0 ||
      parsed.volume > 1
    ) {
      return { muted: false, volume: 0.65 };
    }
    return { muted: parsed.muted, volume: parsed.volume };
  } catch {
    return { muted: false, volume: 0.65 };
  }
}

function resolveStorage(
  storage: ThemeAudioStorage | undefined,
  storageFactory: (() => ThemeAudioStorage) | undefined,
): ThemeAudioStorage | undefined {
  if (storage !== undefined) return storage;
  try {
    return storageFactory?.() ?? (typeof window === "undefined" ? undefined : window.localStorage);
  } catch {
    return undefined;
  }
}

export function createThemeAudioController(
  theme: ThemeDefinition,
  options: {
    backendFactory?: () => ThemeAudioBackend;
    storage?: ThemeAudioStorage;
    storageFactory?: () => ThemeAudioStorage;
  } = {},
): ThemeAudioController {
  const listeners = new Set<() => void>();
  const playedKeys = new Set<string>();
  const backendFactory = options.backendFactory ?? (() => new BrowserThemeAudioBackend());
  const storage = resolveStorage(options.storage, options.storageFactory);
  const preferences = safePreferences(storage);
  const queuedCues: QueuedCue[] = [];
  let backend: ThemeAudioBackend | null = null;
  let disposed = false;
  let playbackTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshot: ThemeAudioSnapshot = { status: "locked", ...preferences };

  const publish = (next: ThemeAudioSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const persist = () => {
    try {
      storage?.setItem(
        STORAGE_KEY,
        JSON.stringify({ muted: snapshot.muted, volume: snapshot.volume }),
      );
    } catch {
      // Storage is optional; retain the in-memory preference.
    }
  };
  const cueFor = (role: ThemeAudioRole): ThemeAudioCue => theme.audio.cues[role];
  const stopPlayback = () => {
    if (playbackTimer !== null) clearTimeout(playbackTimer);
    playbackTimer = null;
    queuedCues.length = 0;
    backend?.stop();
  };
  const playQueuedCue = (cue: QueuedCue) => {
    if (backend === null || disposed || snapshot.status !== "ready" || snapshot.muted) return;
    try {
      backend.play(cue.offsetSeconds, cue.durationSeconds);
    } catch {
      return;
    }
    playbackTimer = setTimeout(() => {
      playbackTimer = null;
      const next = queuedCues.shift();
      if (next !== undefined) playQueuedCue(next);
    }, cue.durationSeconds * 1_000);
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async enable() {
      if (disposed || snapshot.status === "loading" || snapshot.status === "ready") return;
      try {
        backend = backendFactory();
        const activation = backend.activate();
        publish({ ...snapshot, status: "loading" });
        await activation;
        backend.setVolume(snapshot.muted ? 0 : snapshot.volume);
        await backend.load(theme.audio.spriteUrl);
        if (!disposed) publish({ ...snapshot, status: "ready" });
      } catch {
        stopPlayback();
        backend?.dispose();
        backend = null;
        if (!disposed) publish({ ...snapshot, status: "unavailable" });
      }
    },
    play(role, dedupeKey) {
      if (playedKeys.has(dedupeKey)) return;
      playedKeys.add(dedupeKey);
      if (
        disposed ||
        backend === null ||
        snapshot.status !== "ready" ||
        snapshot.muted ||
        snapshot.volume === 0
      ) {
        return;
      }
      const cue = cueFor(role);
      if (playbackTimer === null) playQueuedCue(cue);
      else if (queuedCues.length < 4) queuedCues.push(cue);
    },
    setMuted(muted) {
      if (snapshot.muted === muted) return;
      publish({ ...snapshot, muted });
      persist();
      if (muted) stopPlayback();
      backend?.setVolume(muted ? 0 : snapshot.volume);
    },
    setVolume(volume) {
      const clamped = Math.min(1, Math.max(0, volume));
      if (snapshot.volume === clamped) return;
      publish({ ...snapshot, volume: clamped });
      persist();
      backend?.setVolume(snapshot.muted ? 0 : clamped);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopPlayback();
      backend?.dispose();
      backend = null;
      listeners.clear();
    },
  };
}
