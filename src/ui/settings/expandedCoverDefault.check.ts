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
  getExpandedCoverDefault,
  setExpandedCoverDefault,
} from "./motionArtwork";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(!getExpandedCoverDefault(), "the split does not open by default");
setExpandedCoverDefault(true);
check(getExpandedCoverDefault(), "on persists");
store.set("expanded-cover-default", "garbage");
check(!getExpandedCoverDefault(), "only true enables");
setExpandedCoverDefault(false);
check(!getExpandedCoverDefault(), "off persists");
check(!store.has("expanded-cover-default"), "off is stored as absence");

console.log("expandedCoverDefault.check.ts passed");
