export {};

import {
  isWarmingTrack,
  joinWarm,
  shouldTearDownBeforePlay,
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

console.log("warmHandoff.check.ts passed");
