export {};
import { acceptAddonStream, canonicalMime, normalizeBitrateKbps, normalizeExpiresAtMs, normalizeSampleRate } from "./format";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(acceptAddonStream({ url: "https://cdn/a.flac", format: "flac" }, "rust").ok, "flac accepted on rust");
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

check(normalizeSampleRate(44.1) === 44100, "kHz promoted");
check(normalizeSampleRate(48000) === 48000, "Hz preserved");
check(normalizeBitrateKbps(1411) === 1411, "kbps preserved");
check(normalizeBitrateKbps(1411000) === 1411, "bps converted to kbps");
check(normalizeExpiresAtMs(1760000000) === 1760000000000, "seconds converted to ms");
check(normalizeExpiresAtMs("2026-11-10T00:00:00Z") === Date.parse("2026-11-10T00:00:00Z"), "ISO parsed");
check(canonicalMime({ format: "mp3" }) === "audio/mpeg", "mp3 mime");
check(canonicalMime({ codec: "opus", container: "webm" }) === "audio/webm", "opus webm mime");

console.log("addon/format: ok");
