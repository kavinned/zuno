export {};

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(
    actual === expected,
    `${message}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

const {
  getDefaultPlaylist,
  setDefaultPlaylist,
} = await import("./defaultPlaylist");

equal(getDefaultPlaylist(), null, "default playlist starts null");

setDefaultPlaylist({ id: "PL12345", title: "My Favorites" });
const stored = getDefaultPlaylist();
check(stored !== null, "default playlist is set");
equal(stored?.id, "PL12345", "stores playlist id");
equal(stored?.title, "My Favorites", "stores playlist title");
check(store.has("player-default-playlist"), "persisted in localStorage");

// Clearing default playlist
setDefaultPlaylist(null);
equal(getDefaultPlaylist(), null, "default playlist can be cleared");
check(!store.has("player-default-playlist"), "cleared from storage when null");

console.log("defaultPlaylist self-check passed");
