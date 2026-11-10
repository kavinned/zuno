import type { AddonStreamAnswer } from "./types";

export interface AcceptedAddonStream {
  url: string;
  mimeType: string;
  lossless: boolean;
  sampleRateHz?: number;
  bitDepth?: number;
  kbps?: number;
  expiresAtMs?: number;
}

export type AddonEngine = "rust" | "native";

export type AddonStreamResult =
  | { ok: true; stream: AcceptedAddonStream }
  | { ok: false; reason: string };

type StreamKind = "flac" | "alac" | "aac" | "mp3" | "vorbis" | "opus" | "pcm" | "aiff";

const LOSSLESS_KINDS: ReadonlySet<StreamKind> = new Set(["flac", "alac", "pcm", "aiff"]);
const NATIVE_UNSUPPORTED: ReadonlySet<StreamKind> = new Set(["alac", "aiff"]);

const REFUSED_MIMES: ReadonlySet<string> = new Set([
  "application/vnd.apple.mpegurl",
  "application/dash+xml",
]);
const REFUSED_TRANSPORTS: ReadonlySet<string> = new Set(["hls", "dash"]);
const REFUSED_FORMATS: ReadonlySet<string> = new Set([
  "hls",
  "dash",
  "eac3",
  "ec-3",
  "ac3",
  "dts",
  "dsd",
  "ape",
  "wavpack",
]);
const KIND_BY_MIME: Record<string, StreamKind> = {
  "audio/flac": "flac",
  "audio/mp4": "aac",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/ogg": "vorbis",
  "audio/webm": "opus",
  "audio/wav": "pcm",
  "audio/aiff": "aiff",
};

const MIME_BY_FORMAT: Record<string, { mimeType: string; kind: StreamKind }> = {
  flac: { mimeType: "audio/flac", kind: "flac" },
  alac: { mimeType: "audio/mp4", kind: "alac" },
  mp3: { mimeType: "audio/mpeg", kind: "mp3" },
  aac: { mimeType: "audio/aac", kind: "aac" },
  vorbis: { mimeType: "audio/ogg", kind: "vorbis" },
  opus: { mimeType: "audio/ogg", kind: "opus" },
  pcm: { mimeType: "audio/wav", kind: "pcm" },
  aiff: { mimeType: "audio/aiff", kind: "aiff" },
};

const FALSE_LIKE: ReadonlySet<string> = new Set(["false", "none", "0", "no", "off"]);
const ATMOS_MARKERS: ReadonlySet<string> = new Set(["atmos", "joc"]);

function normalized(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function firstToken(...values: Array<string | undefined>): string {
  for (const value of values) {
    const token = normalized(value);
    if (token !== "") return token;
  }
  return "";
}

function isUnencrypted(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return true;
  return typeof value === "string" && FALSE_LIKE.has(value.trim().toLowerCase());
}

function hasAtmosMarker(answer: AddonStreamAnswer): boolean {
  const modes = [answer.audioMode, ...(answer.audioModes ?? [])];
  return modes.some((mode) => ATMOS_MARKERS.has(normalized(mode)));
}

function isRefusedTransport(answer: AddonStreamAnswer): boolean {
  const mime = normalized(answer.mimeType?.split(";")[0]);
  if (REFUSED_MIMES.has(mime)) return true;
  return [answer.manifest, answer.mediaType, answer.format].some((value) =>
    REFUSED_TRANSPORTS.has(normalized(value)),
  );
}

function hasRefusedFormat(answer: AddonStreamAnswer): boolean {
  return [answer.format, answer.codec, answer.fileCodec].some((value) =>
    REFUSED_FORMATS.has(normalized(value)),
  );
}

function resolveKind(answer: AddonStreamAnswer): { mimeType: string; kind: StreamKind } | null {
  const explicitMime = normalized(answer.mimeType?.split(";")[0]);
  if (explicitMime !== "") {
    const baseKind = KIND_BY_MIME[explicitMime];
    if (baseKind === undefined) return null;
    const codec = firstToken(answer.codec, answer.fileCodec);
    const format = normalized(answer.format);
    if (explicitMime === "audio/mp4") {
      const kind = codec === "alac" || format === "alac" ? "alac" : "aac";
      return { mimeType: explicitMime, kind };
    }
    if (explicitMime === "audio/ogg") {
      const kind = codec === "opus" || format === "opus" ? "opus" : "vorbis";
      return { mimeType: explicitMime, kind };
    }
    return { mimeType: explicitMime, kind: baseKind };
  }

  const container = firstToken(answer.container, answer.containerFormat);
  const codec = firstToken(answer.codec, answer.fileCodec);
  const token = codec !== "" ? codec : normalized(answer.format);
  const resolved = MIME_BY_FORMAT[token];
  if (resolved === undefined) return null;
  if (resolved.kind === "aac" && (container === "mp4" || container === "m4a")) {
    return { mimeType: "audio/mp4", kind: "aac" };
  }
  if (resolved.kind === "opus" && container === "webm") {
    return { mimeType: "audio/webm", kind: "opus" };
  }
  return resolved;
}

export function canonicalMime(answer: AddonStreamAnswer): string | null {
  return resolveKind(answer)?.mimeType ?? null;
}

export function normalizeSampleRate(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1000 ? value * 1000 : value;
}

export function normalizeBitrateKbps(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return value > 3000 ? Math.round(value / 1000) : value;
}

export function normalizeExpiresAtMs(value?: string | number): number | undefined {
  if (value === undefined) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return ms < 1e12 ? ms * 1000 : ms;
}

export function acceptAddonStream(answer: AddonStreamAnswer, engine: AddonEngine): AddonStreamResult {
  const url = answer.url?.trim();
  if (!url) return { ok: false, reason: "url" };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reason: "url" };
  if (parsed.username || parsed.password) return { ok: false, reason: "url" };

  if (!isUnencrypted(answer.encrypted)) return { ok: false, reason: "encrypted" };
  if (isRefusedTransport(answer)) return { ok: false, reason: "transport" };
  if (hasAtmosMarker(answer) || hasRefusedFormat(answer)) return { ok: false, reason: "format" };

  const resolved = resolveKind(answer);
  if (resolved === null) return { ok: false, reason: "format" };
  if (engine === "native" && NATIVE_UNSUPPORTED.has(resolved.kind)) return { ok: false, reason: "engine" };

  const stream: AcceptedAddonStream = {
    url,
    mimeType: resolved.mimeType,
    lossless: LOSSLESS_KINDS.has(resolved.kind),
  };
  const sampleRateHz = normalizeSampleRate(answer.sampleRate);
  if (sampleRateHz !== undefined) stream.sampleRateHz = sampleRateHz;
  if (answer.bitDepth !== undefined) stream.bitDepth = answer.bitDepth;
  const kbps = normalizeBitrateKbps(answer.bitrate);
  if (kbps !== undefined) stream.kbps = kbps;
  const expiresAtMs = normalizeExpiresAtMs(answer.expiresAt);
  if (expiresAtMs !== undefined) stream.expiresAtMs = expiresAtMs;

  return { ok: true, stream };
}
