/**
 * Self-check for the 10 s warm gate poller.
 *
 * The controller is instantiated directly (same stubs as `shuffleFlag.check.ts`); the poller's
 * interval is faked so ticks can be driven by hand instead of waiting real seconds. Covers the
 * behaviours the first review could only inspect: one poller at a time, following a track
 * change, waiting out a foreign warm, stopping when there is nothing to wait for, and not
 * repeating the metadata fetch on re-entry.
 */
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
/* `connectivity` reads this at module load, so it has to be set before the import below. */
Object.defineProperty(globalThis, "navigator", {
  value: { onLine: true },
  configurable: true,
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

type Tick = () => void;
const intervals = new Map<number, Tick>();
let nextTimerId = 1;
Object.assign(globalThis, {
  setInterval: (callback: Tick) => {
    intervals.set(nextTimerId, callback);
    return nextTimerId++;
  },
  clearInterval: (id: number) => void intervals.delete(id),
});

function tick(): void {
  for (const callback of [...intervals.values()]) callback();
}

const track = (id: string): Track =>
  ({ id, source: "youtube", title: id, artist: "a" }) as Track;

interface Probe {
  state: { status: string; currentTrack: Track | null };
  loadedTrackId: string | null;
  warming: { trackId: string; promise: Promise<void> } | null;
  playbackOrderMode: string;
  queue: { select(index: number): unknown };
  audioEngine: {
    getCurrentTime(): number;
    usesNativeAudio(): boolean;
    usesRustAudio(): boolean;
  };
  warmNextTrack(skipMetadata?: boolean): void;
  dispose(): void;
}

let positionSec = 0;
let streamCalls: string[] = [];
let metaCalls: string[] = [];

function make(): {
  controller: InstanceType<typeof PlayerController>;
  probe: Probe;
} {
  streamCalls = [];
  metaCalls = [];
  intervals.clear();
  positionSec = 0;

  const dataSource = {
    getTrack: async (id: string) => {
      metaCalls.push(id);
      return track(id);
    },
    getStreamData: async (item: Track) => {
      streamCalls.push(item.id);
      return {} as StreamData;
    },
  } as unknown as DataSource;

  const controller = new PlayerController(dataSource);
  controller.restoreSession({
    currentTrack: null,
    history: [],
    queue: [track("a"), track("b"), track("c")],
    queueIndex: 0,
    status: "idle",
    positionSec: 0,
    volume: 1,
    muted: false,
    autoplayEnabled: false,
    playbackOrderMode: "in-order",
    shuffleEnabled: false,
    isPlaylistMode: true,
  });

  const probe = controller as unknown as Probe;
  probe.state.currentTrack = track("a");
  probe.state.status = "playing";
  probe.loadedTrackId = "a";
  probe.audioEngine.getCurrentTime = () => positionSec;
  probe.audioEngine.usesNativeAudio = () => true;
  probe.audioEngine.usesRustAudio = () => false;
  return { controller, probe };
}

// Gate closed: one poller, no resolve, and ticks before the gate change nothing.
{
  const { probe } = make();
  positionSec = 3;
  probe.warmNextTrack();
  equal(intervals.size, 1, "a closed gate starts exactly one poller");
  probe.warmNextTrack();
  equal(intervals.size, 1, "a repeated call keeps the single poller");
  equal(streamCalls.length, 0, "no audio resolve before the gate opens");

  tick();
  equal(streamCalls.length, 0, "a tick below the gate resolves nothing");

  positionSec = 11;
  tick();
  equal(streamCalls.length, 1, "the tick past 10 s starts the warm");
  equal(intervals.size, 0, "the poller stops after firing");
}

// Gate already open: warm immediately, no poller.
{
  const { probe } = make();
  positionSec = 30;
  probe.warmNextTrack();
  equal(streamCalls.length, 1, "an open gate warms without waiting");
  equal(intervals.size, 0, "an open gate starts no poller");
}

// A foreign warm in flight must not swallow the call; the poller retries until it settles.
{
  const { probe } = make();
  positionSec = 5;
  probe.warming = { trackId: "x", promise: new Promise(() => {}) };
  probe.warmNextTrack();
  equal(intervals.size, 1, "a foreign warm still leaves a poller waiting");

  positionSec = 12;
  tick();
  equal(streamCalls.length, 0, "no second resolve while the foreign warm runs");
  equal(intervals.size, 1, "the poller keeps waiting for the foreign warm");

  probe.warming = null;
  tick();
  equal(streamCalls.length, 1, "the warm resumes once the foreign one settles");
  equal(intervals.size, 0, "the poller stops after the retry succeeds");
  equal(metaCalls.length, 1, "poller re-entry does not repeat the metadata fetch");
}

// The poller follows the current track rather than the one it was started for.
{
  const { probe } = make();
  positionSec = 5;
  probe.warmNextTrack();
  equal(intervals.size, 1, "poller started for the first track");

  probe.state.currentTrack = track("b");
  probe.loadedTrackId = "b";
  probe.queue.select(1);
  positionSec = 4;
  tick();
  equal(streamCalls.length, 0, "the new track restarts the gate");
  positionSec = 12;
  tick();
  equal(streamCalls.join(","), "c", "the poller warms the new track's successor");
}

// Nothing to wait for: idle and error stop the poller.
{
  const { probe } = make();
  positionSec = 5;
  probe.warmNextTrack();
  equal(intervals.size, 1, "poller running before idle");
  probe.state.status = "idle";
  tick();
  equal(intervals.size, 0, "idle stops the poller");
}
{
  const { probe } = make();
  positionSec = 5;
  probe.warmNextTrack();
  probe.state.status = "error";
  tick();
  equal(intervals.size, 0, "error stops the poller");
}

// Disposal clears the poller and prevents a late continuation from starting a new one.
{
  const { controller, probe } = make();
  positionSec = 5;
  probe.warmNextTrack();
  equal(intervals.size, 1, "poller running before dispose");
  controller.dispose();
  equal(intervals.size, 0, "dispose clears the poller");
  probe.warmNextTrack();
  equal(intervals.size, 0, "a disposed controller starts no poller");
}

// No successor: repeat-one and the queue tail start nothing.
{
  const { probe } = make();
  positionSec = 5;
  probe.playbackOrderMode = "repeat-one";
  probe.warmNextTrack();
  equal(intervals.size, 0, "repeat-one starts no poller");
  equal(streamCalls.length, 0, "repeat-one warms nothing");
}
{
  const { probe } = make();
  positionSec = 5;
  probe.state.currentTrack = track("c");
  probe.loadedTrackId = "c";
  probe.queue.select(2);
  probe.warmNextTrack();
  equal(intervals.size, 0, "the queue tail starts no poller");
  equal(streamCalls.length, 0, "the queue tail warms nothing");
}

console.log("warmGate.check.ts passed");
