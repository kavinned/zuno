/**
 * Self-check for play history persistence.
 *
 * What is under test: an addon search row's media URL is in-memory only. It can be a signed
 * CDN address, and the history is written to both localStorage and the app-settings store.
 */
export {};

const store = new Map<string, string>();
Object.assign(globalThis, {
  window: globalThis,
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const { getPlayHistory, recordPlay } = await import("./playHistory");

const mediaUrl = "https://cdn.example/audio.flac?token=secret";
const track = {
  id: "addon.550e8400-e29b-41d4-a716-446655440000.ABCDEFGHIJKLMNOPQRSTUV",
  source: "addon" as const,
  title: "T",
  artist: "A",
  addon: {
    sourceId: "550e8400-e29b-41d4-a716-446655440000",
    trackId: "song-1",
    title: "T",
    artist: "A",
    streamUrl: mediaUrl,
  },
};

recordPlay(track);

const raw = store.get("zuno.play-history.v1") ?? "";
check(raw !== "", "the history was written");
check(!raw.includes("streamUrl"), "the persisted entry omits streamUrl");
check(!raw.includes("token=secret"), "the persisted entry omits the media URL");
check(
  getPlayHistory()[0]?.track.addon?.streamUrl === mediaUrl,
  "the in-memory entry keeps the URL for the direct-stream fallback",
);

console.log("playHistory.check passed");
