/**
 * Self-check for app session and playback position persistence.
 *
 *   npm run check
 */
export {};

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const {
  clearAppSession,
  loadAppSession,
  loadPlaybackPosition,
  saveAppSession,
  savePlaybackPosition,
} = await import("./appSession");

// 1. Position snapshot saves and loads
savePlaybackPosition("track-1", 42.5);
equal(loadPlaybackPosition(), { trackId: "track-1", positionSec: 42.5 }, "loads saved position");

// 2. Full session save + position overlay on load
const mockSession = {
  version: 1 as const,
  tabs: [{ id: "tab-1", view: "home" as const }],
  activeTabId: "tab-1",
  nextTabId: 2,
  player: {
    activeId: "tab-1",
    playbackOwnerId: "tab-1",
    players: {
      "tab-1": {
        currentTrack: { id: "track-1", title: "Song 1", artist: "Artist 1", artists: [], source: "youtube" as const },
        history: [],
        queue: [],
        queueIndex: 0,
        positionSec: 10,
        volume: 1,
        muted: false,
        autoplayEnabled: false,
        playbackOrderMode: "in-order" as const,
        shuffleEnabled: false,
        isPlaylistMode: false,
        status: "playing" as const,
      },
    },
  },
};

saveAppSession(mockSession);
const restored = loadAppSession();
check(restored !== null, "session restores");
equal(restored?.player.players["tab-1"].positionSec, 42.5, "position heartbeat overlays onto restored session");

// 3. Clear session wipes both session and position heartbeat
clearAppSession();
equal(loadAppSession(), null, "session cleared");
equal(loadPlaybackPosition(), null, "position cleared");

console.log("appSession.check passed");
