export {};

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    __TAURI_INTERNALS__: {
      invoke: () => Promise.resolve(null),
      transformCallback: () => 0,
    },
  },
});
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
});

import type { DataSource, StreamData } from "../datasource/DataSource";
import type { Track } from "../datasource/types";
import { setLosslessOptOut } from "../internal/losslessOptOut";
import { getAudioEngineMode } from "../ui/settings/audioEngine";

const { PlayerController } = await import("./PlayerController");

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const track = (id: string): Track => ({ id, source: "youtube", title: id, artist: "a" });

interface Probe {
  state: { currentTrack: Track | null; status: string };
  loadedTrackId: string | null;
  warmedStream: { trackId: string; engine: string; data: StreamData } | null;
  gaplessQueued: boolean;
  queue: { set(tracks: Track[], index?: number): void };
  claimWarmedStream(trackId: string): StreamData | undefined;
  queueGapless(next: Track | null, remainingSec: number): void;
  usesPreloadDeck(track: Track): boolean;
  ensureTrackLoaded(track: Track): Promise<void>;
  audioEngine: {
    hasPreloaded(videoId: string): boolean;
    transitionToPreloaded(videoId: string, fadeMs: number): Promise<boolean>;
    queueGapless(videoId: string | null): void;
    loadTrack(...args: unknown[]): Promise<void>;
    usesNativeAudio(): boolean;
    usesRustAudio(): boolean;
    getDuration(): number;
    getCurrentTime(): number;
  };
}

function make() {
  const dataSource = {
    getTrack: async (id: string) => track(id),
    getStreamData: async (): Promise<StreamData> => ({
      bytes: new ArrayBuffer(1),
      mimeType: "audio/mp4",
      sourceUrl: "http://127.0.0.1/audio",
    }),
    beginPlayReport: async () => {},
  } as unknown as DataSource;
  const controller = new PlayerController(dataSource);
  const probe = controller as unknown as Probe;
  probe.state.currentTrack = track("a");
  probe.state.status = "playing";
  probe.loadedTrackId = "a";
  probe.queue.set([track("a")], 0);
  probe.audioEngine.usesNativeAudio = () => true;
  probe.audioEngine.usesRustAudio = () => false;
  probe.audioEngine.getDuration = () => 0;
  probe.audioEngine.getCurrentTime = () => 0;
  return { controller, probe };
}

{
  const { probe } = make();
  setLosslessOptOut("b", true);
  probe.warmedStream = { trackId: "b", engine: getAudioEngineMode(), data: { mimeType: "audio/flac" } };
  equal(probe.claimWarmedStream("b"), undefined, "an opted-out warm is dropped");
  equal(probe.warmedStream, null, "the dropped warm slot is cleared");

  probe.warmedStream = { trackId: "c", engine: getAudioEngineMode(), data: { mimeType: "audio/mp4" } };
  check(probe.claimWarmedStream("c") !== undefined, "a normal warm is still claimed");
  setLosslessOptOut("b", false);
}

{
  const { probe } = make();
  setLosslessOptOut("b", true);
  const armed: Array<string | null> = [];
  probe.audioEngine.hasPreloaded = () => true;
  probe.audioEngine.queueGapless = (id) => {
    armed.push(id);
  };
  probe.queueGapless(track("c"), 1);
  probe.queueGapless(track("b"), 1);
  equal(armed[0], "c", "gapless arms for a normal next track");
  equal(armed[1], null, "gapless is disarmed for an opted-out next track");
  equal(probe.gaplessQueued, false, "the gapless flag is cleared");
  setLosslessOptOut("b", false);
}

{
  const { probe } = make();
  setLosslessOptOut("b", true);
  const calls: string[] = [];
  probe.usesPreloadDeck = () => {
    calls.push("usesPreloadDeck");
    return true;
  };
  probe.audioEngine.hasPreloaded = () => true;
  probe.audioEngine.transitionToPreloaded = async () => {
    calls.push("transition");
    return true;
  };
  probe.audioEngine.loadTrack = async () => {
    calls.push("loadTrack");
  };
  probe.queueGapless = () => {};

  await probe.ensureTrackLoaded(track("b"));

  check(calls.includes("loadTrack"), "an opted-out track loads normally");
  check(!calls.includes("usesPreloadDeck"), "the preload deck is not consulted");
  check(!calls.includes("transition"), "the stale FLAC deck is not transitioned to");
  setLosslessOptOut("b", false);
}

console.log("losslessPrefetch: ok");
