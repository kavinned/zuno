export {};

import {
  isWarmingTrack,
  joinWarm,
  shouldStartWarmAudio,
  shouldTearDownBeforePlay,
  WARM_GATE_SEC,
  type WarmSlot,
} from "./warmHandoff";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const slot: WarmSlot = { trackId: "b", promise: Promise.resolve() };

check(isWarmingTrack(slot, "b"), "slot belongs to b");
check(!isWarmingTrack(slot, "a"), "slot does not belong to a");
check(!isWarmingTrack(null, "b"), "no slot matches nothing");

check(!shouldTearDownBeforePlay(false, "b", "b"), "warm target keeps the deck");
check(shouldTearDownBeforePlay(false, "a", "b"), "other target tears the deck down");
check(!shouldTearDownBeforePlay(true, null, "b"), "preloaded target keeps the deck");
check(shouldTearDownBeforePlay(false, null, "b"), "no warm tears the deck down");

const stalled = deferred();
check(
  (await joinWarm({ trackId: "b", promise: stalled.promise }, "b", 10)) === false,
  "a stalled warm times out instead of hanging the click",
);
stalled.resolve();

check(await joinWarm(slot, "b", 1000), "a settled warm joins");
check((await joinWarm(slot, "a", 10)) === false, "a warm for another track is not joined");

check(!shouldStartWarmAudio(null, null, 30), "no loaded track and no current track never warms");
check(!shouldStartWarmAudio("a", "a", WARM_GATE_SEC - 0.01), "just under the gate does not warm");
check(shouldStartWarmAudio("a", "a", WARM_GATE_SEC), "the gate opens exactly at 10s");
check(shouldStartWarmAudio("a", "a", 300), "a seek past the gate warms immediately");
check(!shouldStartWarmAudio("a", "b", 30), "a stale loaded id does not warm the new track");
check(!shouldStartWarmAudio(null, "b", 30), "nothing loaded yet does not warm");

console.log("warmHandoff.check.ts passed");
