export {};
import { acceptAddonStream, canonicalMime, normalizeBitrateKbps, normalizeExpiresAtMs, normalizeSampleRate } from "./format";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(acceptAddonStream({ url: "https://cdn/a.flac", format: "flac" }, "rust").ok, "flac accepted on rust");
const bareFlac = acceptAddonStream({ url: "https://cdn/a", format: "flac" }, "rust");
check(bareFlac.ok && bareFlac.stream.codec === "flac", "an accepted stream names its codec");
const alac = acceptAddonStream({ url: "https://cdn/a", format: "alac", codec: "alac", container: "mp4", mimeType: "audio/mp4" }, "rust");
check(alac.ok && alac.stream.lossless, "alac accepted and lossless on rust");
const alacNative = acceptAddonStream({ url: "https://cdn/a", format: "alac", codec: "alac", container: "mp4", mimeType: "audio/mp4" }, "native");
check(!alacNative.ok && alacNative.reason === "engine", "alac refused on native");
check(acceptAddonStream({ url: "https://cdn/a.m4a", format: "aac", codec: "aac", container: "mp4", mimeType: "audio/mp4" }, "native").ok, "aac accepted on native");
check(!acceptAddonStream({ url: "https://cdn/a.aiff", format: "aiff" }, "native").ok, "aiff refused on native");
check(!acceptAddonStream({ url: "https://cdn/a", format: "flac", encrypted: "widevine" }, "rust").ok, "drm refused");
check(acceptAddonStream({ url: "https://cdn/a", format: "flac", encrypted: "none" }, "rust").ok, "encrypted none accepted");
check(!acceptAddonStream({ url: "https://cdn/a", format: "flac", mediaType: "hls" }, "rust").ok, "hls refused");
check(!acceptAddonStream({ url: "https://cdn/a", format: "dash" }, "rust").ok, "dash refused");
check(!acceptAddonStream({ url: "https://cdn/a", format: "flac", audioMode: "ATMOS" }, "rust").ok, "atmos refused");
check(!acceptAddonStream({ url: "ftp://cdn/a", format: "flac" }, "rust").ok, "non-http refused");
check(!acceptAddonStream({ url: "https://user:pass@cdn/a", format: "flac" }, "rust").ok, "credentials refused");
check(acceptAddonStream({ url: "http://localhost/a", format: "flac" }, "rust").ok, "http accepted");
check(!acceptAddonStream({ url: "https://cdn/a", format: "ape" }, "rust").ok, "unsupported codec refused");
check(!acceptAddonStream({ url: 42 as unknown as string, format: "flac" }, "rust").ok, "malformed url refused without throwing");
check(!acceptAddonStream({ url: "https://cdn/a", format: 3 as unknown as string }, "rust").ok, "malformed format refused without throwing");
check(!acceptAddonStream({ url: "https://cdn/a", format: "flac", audioModes: "ATMOS" as unknown as string[] }, "rust").ok, "string audioModes still refuses atmos");
const unknownMime = acceptAddonStream({ url: "https://cdn/a", format: "flac", mimeType: "audio/x-flac" }, "rust");
check(unknownMime.ok && unknownMime.stream.codec === "flac", "an unknown mime falls back to the format");
check(unknownMime.ok && unknownMime.stream.mimeType === "audio/flac", "the fallback supplies a canonical mime");
check(!acceptAddonStream({ url: "https://cdn/a", mimeType: "audio/unknown" }, "rust").ok, "an unknown mime without a codec still refuses");

check(normalizeSampleRate(44.1) === 44100, "kHz promoted");
check(normalizeSampleRate(48000) === 48000, "Hz preserved");
check(normalizeBitrateKbps(1411) === 1411, "kbps preserved");
check(normalizeBitrateKbps(1411000) === 1411, "bps converted to kbps");
check(normalizeExpiresAtMs(1760000000) === 1760000000000, "seconds converted to ms");
check(normalizeExpiresAtMs("2026-11-10T00:00:00Z") === Date.parse("2026-11-10T00:00:00Z"), "ISO parsed");
check(canonicalMime({ format: "mp3" }) === "audio/mpeg", "mp3 mime");
check(canonicalMime({ codec: "opus", container: "webm" }) === "audio/webm", "opus webm mime");

console.log("addon/format: ok");
