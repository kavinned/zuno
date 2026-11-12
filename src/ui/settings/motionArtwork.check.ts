export {};

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} },
});

import {
  DEFAULT_MOTION_ARTWORK,
  getMotionArtworkEnabled,
  setMotionArtworkEnabled,
} from "./motionArtwork";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(DEFAULT_MOTION_ARTWORK, "motion artwork is on by default");
check(getMotionArtworkEnabled(), "an unset preference reads as on");
setMotionArtworkEnabled(false);
check(!getMotionArtworkEnabled(), "off persists");
store.set("motion-artwork", "garbage");
check(getMotionArtworkEnabled() === false, "only true re-enables");
setMotionArtworkEnabled(true);
check(getMotionArtworkEnabled(), "on persists");
check(!store.has("motion-artwork"), "the default is stored as absence");

console.log("motionArtwork.check.ts passed");
