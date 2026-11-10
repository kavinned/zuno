/**
 * Routing checks for addon tracks in `YouTubeMusicDataSource`.
 *
 * The addon service is faked, so nothing here reaches Tauri or an addon: what is under test is
 * that a source marked `addon` takes the addon path, carries the addon style and byte length
 * to Rust, and never falls through to YouTube — even when no addon service is wired at all.
 */
export {};

import { YouTubeMusicDataSource } from "../youtube/YouTubeMusicDataSource";
import type { AddonPlaybackSource, Track } from "../types";
import type { ResolvedAddonStream } from "./service";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const track: Track = {
  id: "addon.550e8400-e29b-41d4-a716-446655440000.ABCDEFGHIJKLMNOPQRSTUV",
  source: "addon",
  title: "T",
  artist: "A",
  addon: {
    sourceId: "550e8400-e29b-41d4-a716-446655440000",
    trackId: "song-1",
    title: "T",
    artist: "A",
  },
};

const resolved: ResolvedAddonStream = {
  url: "http://127.0.0.1:8787/stream/song-1",
  mimeType: "audio/flac",
  contentLength: 1234,
  lossless: true,
};

const calls: Array<{ quality: string; engine: string | undefined }> = [];
const fakeAddons: AddonPlaybackSource = {
  getTrack: async (id) => {
    equal(id, track.id, "getTrack receives the addon id");
    return track;
  },
  resolveTrack: async (_track, quality, options) => {
    calls.push({ quality, engine: options?.engine });
    return resolved;
  },
  allowDownloads: () => true,
};

const source = new YouTubeMusicDataSource(fakeAddons);

const loaded = await source.getTrack(track.id);
equal(loaded.id, track.id, "addon getTrack delegates to the addon source");
equal(loaded.source, "addon", "addon getTrack returns the addon record, not a fabricated YouTube one");

const stream = await source.getStreamData(track);
check(stream.rustSource?.kind === "stream", "rust source returned");
equal(stream.rustSource.style, "addon", "addon style marked");
equal(stream.rustSource.contentLength, 1234, "content length propagated");
equal(stream.rustSource.url, resolved.url, "stream url propagated");
equal(stream.rustSource.mimeType, resolved.mimeType, "stream mime type propagated");
equal(calls.length, 1, "resolveTrack called once");
equal(calls[0].quality, "high", "streaming quality passed through");
equal(calls[0].engine, undefined, "rust path lets the service choose its engine");

const dl = await source.resolveDownloadUrl(track, "high");
equal(dl.style, "addon", "download marked addon");
equal(dl.contentLength, 1234, "download length propagated");

const deniedSource = new YouTubeMusicDataSource({ ...fakeAddons, allowDownloads: () => false });
let denied = false;
try { await deniedSource.resolveDownloadUrl(track, "high"); } catch { denied = true; }
check(denied, "allowDownloads false refuses before resolving");

let threw = false;
try {
  await new YouTubeMusicDataSource().getTrack(track.id);
} catch {
  threw = true;
}
check(threw, "addon id without service throws, never falls through to YouTube");

console.log("addon/routing: ok");
