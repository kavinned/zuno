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
import type { AddonSubstitutionMatch, ResolvedAddonStream } from "./service";
import { setAudioEngineMode } from "../../ui/settings/audioEngine";

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
  findLosslessMatch: async () => null,
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

const youtubeTrack: Track = {
  id: "dQw4w9WgXcQ",
  source: "youtube",
  title: 'Gehra Hua (From "Dhurandhar")',
  artist: "Arijit Singh",
  durationSec: 362,
};

resolved.sampleRateHz = 44100;
resolved.bitDepth = 16;
resolved.kbps = 1411;

let substitutionCalls = 0;
const substitutionMatch: AddonSubstitutionMatch = { track, stream: resolved };
const substitutionAddons: AddonPlaybackSource = {
  ...fakeAddons,
  findLosslessMatch: async (target) => {
    substitutionCalls += 1;
    equal(target.id, youtubeTrack.id, "the substitution target is the YouTube track");
    return substitutionMatch;
  },
};

const losslessSource = new YouTubeMusicDataSource(substitutionAddons, () => "lossless");
losslessSource.resolveStreamUrl = async () => ({
  url: "https://yt.example/audio",
  mimeType: "audio/mp4",
});
const substituted = await losslessSource.getStreamData(youtubeTrack);
check(substituted.rustSource?.kind === "stream", "the substituted stream is a Rust stream");
equal(substituted.rustSource?.style, "addon", "the substituted stream uses the addon style");
equal(substituted.rustSource?.url, resolved.url, "the addon URL is used");
equal(substituted.addonSubstitution?.trackId, track.id, "the substitution is recorded");
equal(substituted.addonSubstitution?.format, undefined, "no format is invented");
equal(substituted.audioInfo?.sampleRateHz, 44100, "audio info is propagated");
equal(substitutionCalls, 1, "substitution runs once");

const highQualitySource = new YouTubeMusicDataSource(substitutionAddons, () => "high");
highQualitySource.resolveStreamUrl = async () => ({
  url: "https://yt.example/audio",
  mimeType: "audio/mp4",
});
const highQuality = await highQualitySource.getStreamData(youtubeTrack);
check(highQuality.rustSource?.kind === "stream", "high quality resolves a YouTube stream");
equal(substitutionCalls, 1, "a non-lossless tier does not ask the addon");
equal(highQuality.rustSource?.url, "https://yt.example/audio", "YouTube is used at high quality");
equal(highQuality.rustSource?.style, undefined, "the YouTube stream keeps the YouTube style");
equal(highQuality.addonSubstitution, undefined, "no substitution is recorded");

const noMatchSource = new YouTubeMusicDataSource(
  { ...substitutionAddons, findLosslessMatch: async () => null },
  () => "lossless",
);
noMatchSource.resolveStreamUrl = async () => ({
  url: "https://yt.example/audio",
  mimeType: "audio/mp4",
});
const noMatch = await noMatchSource.getStreamData(youtubeTrack);
check(noMatch.rustSource?.kind === "stream", "a substitution miss resolves a YouTube stream");
equal(noMatch.rustSource?.url, "https://yt.example/audio", "a miss falls back to YouTube");
equal(noMatch.addonSubstitution, undefined, "a miss records no substitution");

substitutionCalls = 0;
const losslessAddonSource = new YouTubeMusicDataSource(substitutionAddons, () => "lossless");
await losslessAddonSource.getStreamData(track);
equal(substitutionCalls, 0, "an addon track never substitutes");

/*
 * Native engine: Rust can publish a pending buffer and answer before the download finishes,
 * so a CDN failure afterward is invisible to the caller. The substitution fetch must ask for
 * the synchronous mode, whose failure can be caught and turned into a YouTube fallback.
 */
const nativeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
const fakeInvoke = async (cmd: string, args: Record<string, unknown> = {}) => {
  nativeCalls.push({ cmd, args });
  if (cmd !== "fetch_audio_source") return undefined;
  if (args.style === "addon") {
    /* The synchronous fetch is the one whose failure reaches the caller as an error. */
    if (args.synchronous === true) throw new Error("addon fetch failed");
    return {
      url: "http://127.0.0.1/audio/stream-x",
      mimeType: "audio/flac",
      byteLength: 4321,
    };
  }
  return { url: "http://127.0.0.1/audio/youtube", mimeType: "audio/mp4", byteLength: 4321 };
};

const nativeStorage = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: { invoke: fakeInvoke },
  localStorage: {
    getItem: (key: string) => nativeStorage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      nativeStorage.set(key, value);
    },
    removeItem: (key: string) => {
      nativeStorage.delete(key);
    },
  },
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

setAudioEngineMode("native");
substitutionCalls = 0;
const nativeSource = new YouTubeMusicDataSource(substitutionAddons, () => "lossless");
nativeSource.resolveStreamUrl = async () => ({
  url: "https://yt.example/audio",
  mimeType: "audio/mp4",
});
const nativeFallback = await nativeSource.getStreamData(youtubeTrack);
setAudioEngineMode("rust");
equal(nativeFallback.sourceUrl, "http://127.0.0.1/audio/youtube", "a failed addon fetch falls back to YouTube");
equal(nativeFallback.addonSubstitution, undefined, "a failed addon fetch records no substitution");
equal(substitutionCalls, 1, "the native path asks the addon once");
const substitutionFetch = nativeCalls.find(
  (call) => call.cmd === "fetch_audio_source" && call.args.style === "addon",
);
check(substitutionFetch !== undefined, "the addon fetch was attempted");
equal(substitutionFetch.args.contentLength, undefined, "the native substitution fetch omits contentLength");
equal(substitutionFetch.args.synchronous, true, "the native substitution fetch is synchronous");

console.log("addon/routing: ok");
