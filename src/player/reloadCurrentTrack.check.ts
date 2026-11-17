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

/* Fake timers: a successful reload starts the transition ticker, and a real interval would
   keep the check process alive until the harness timeout. */
const intervals = new Map<number, () => void>();
let nextTimerId = 1;
Object.assign(globalThis, {
  setInterval: (callback: () => void) => {
    intervals.set(nextTimerId, callback);
    return nextTimerId++;
  },
  clearInterval: (id: number) => void intervals.delete(id),
});

import type { DataSource, StreamData } from "../datasource/DataSource";
import type { Track } from "../datasource/types";

const { PlayerController } = await import("./PlayerController");

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const track = (id: string): Track => ({ id, source: "youtube", title: id, artist: "a" });

interface Probe {
  state: {
    status: string;
    currentTrack: Track | null;
    history: Track[];
    error: string | null;
  };
  loadedTrackId: string | null;
  pendingSeekTime: number | null;
  warmedStream: { trackId: string; engine: string; data: StreamData } | null;
  isTabActive: boolean;
  queue: { all: Track[]; set(tracks: Track[], index?: number): void };
  ensureTrackLoaded(track: Track): Promise<void>;
  playLoadedTrack(): Promise<boolean>;
  audioEngine: {
    getCurrentTime(): number;
    usesNativeAudio(): boolean;
    usesRustAudio(): boolean;
  };
}

let events: string[] = [];

function make(): { controller: InstanceType<typeof PlayerController>; probe: Probe } {
  events = [];
  const dataSource = {
    getTrack: async (id: string) => {
      events.push(`getTrack:${id}`);
      return track(id);
    },
    getStreamData: async (item: Track) => {
      events.push(`getStreamData:${item.id}`);
      return {} as StreamData;
    },
    updatePlayReport: async (_item: Track, _position: number, final: boolean) => {
      if (final) events.push("finishReport");
    },
    beginPlayReport: async () => {
      events.push("beginReport");
    },
  } as unknown as DataSource;

  const controller = new PlayerController(dataSource);
  const probe = controller as unknown as Probe;
  probe.state.currentTrack = track("yt-1");
  probe.state.history = [track("yt-1")];
  probe.state.status = "playing";
  probe.loadedTrackId = "yt-1";
  probe.isTabActive = true;
  probe.queue.set([track("yt-1"), track("yt-2")], 0);
  probe.audioEngine.getCurrentTime = () => 42;
  probe.audioEngine.usesNativeAudio = () => true;
  probe.audioEngine.usesRustAudio = () => false;
  probe.ensureTrackLoaded = async (item) => {
    events.push(`load:${item.id}`);
    probe.loadedTrackId = item.id;
  };
  probe.playLoadedTrack = async () => {
    events.push("play");
    return true;
  };
  return { controller, probe };
}

{
  const { controller, probe } = make();
  probe.warmedStream = { trackId: "yt-1", engine: "rust", data: {} };
  probe.pendingSeekTime = 12;
  await controller.reloadCurrentTrack();
  equal(events[0], "finishReport", "the outgoing report is finalized before the reload");
  check(events.includes("load:yt-1"), "the current track reloads");
  check(events.includes("play"), "playback starts");
  check(!events.some((event) => event.startsWith("getTrack")), "no metadata is refetched");
  equal(probe.state.history.length, 1, "history is untouched");
  equal(probe.queue.all.map((item) => item.id).join(","), "yt-1,yt-2", "the queue is untouched");
  equal(probe.state.currentTrack?.id, "yt-1", "the current track is unchanged");
  equal(probe.state.status, "playing", "the track is playing");
  equal(probe.warmedStream, null, "the warm slot for this track is discarded");
  equal(probe.pendingSeekTime, null, "no seek position is carried");
}

{
  const { controller, probe } = make();
  probe.state.status = "paused";
  await controller.reloadCurrentTrack();
  check(events.includes("play"), "a reload plays even when the track was paused");
}

{
  const { controller, probe } = make();
  let release!: () => void;
  probe.ensureTrackLoaded = async (item) => {
    events.push(`load:${item.id}`);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    probe.loadedTrackId = item.id;
  };
  const running = controller.reloadCurrentTrack();
  probe.state.currentTrack = track("yt-2");
  release();
  await running;
  check(!events.includes("play"), "a track change during the reload suppresses playback");
}

{
  const { controller, probe } = make();
  probe.ensureTrackLoaded = async () => {
    throw new Error("boom");
  };
  await controller.reloadCurrentTrack();
  equal(probe.state.status, "error", "a failed reload sets the error state");
  check(probe.state.error !== null, "the failure is surfaced");
}

{
  const { controller, probe } = make();
  probe.state.currentTrack = null;
  await controller.reloadCurrentTrack();
  equal(events.length, 0, "no current track means no work");
}

console.log("reloadCurrentTrack: ok");
