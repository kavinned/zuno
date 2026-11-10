import type { AudioQuality } from "../../internal/audioQuality";
import type { Track } from "../types";
import { AddonClient, AddonRequestError, type AddonClientCallOptions } from "./client";
import { acceptAddonStream, type AddonEngine } from "./format";
import type { AddonRegistry, AddonSourcePatch } from "./registry";
import type { AddonRowCache, CachedAddonRow } from "./rows";
import type { AddonLengthProbe, AddonRequest } from "./transport";
import type {
  AddonHealth,
  AddonManifest,
  AddonSearchRow,
  AddonSourceConfig,
  AddonStreamAnswer,
  AddonTrackRef,
} from "./types";
import { isAddonTrackId, sourceFingerprint } from "./url";

/** The four client methods the service needs; tests can fake them without the network. */
export interface AddonClientLike {
  getManifest(options?: AddonClientCallOptions): Promise<AddonManifest | null>;
  search(
    query: string,
    quality: AudioQuality,
    options?: AddonClientCallOptions,
  ): Promise<AddonSearchRow[]>;
  resolveStream(
    trackId: string,
    quality: AudioQuality,
    options?: AddonClientCallOptions,
  ): Promise<AddonStreamAnswer>;
  invalidate(): void;
}

export interface ResolvedAddonStream {
  url: string;
  mimeType: string;
  contentLength?: number;
  codec?: string;
  lossless: boolean;
  sampleRateHz?: number;
  bitDepth?: number;
  kbps?: number;
  expiresAt?: number;
}

export type AddonServiceRows = Pick<
  AddonRowCache,
  "rememberMany" | "read" | "forgetSource" | "toTrack"
>;

export type AddonServiceEngine = "rust" | "native" | "iframe";

export interface AddonServiceDeps {
  registry: AddonRegistry;
  rows: AddonServiceRows;
  request: AddonRequest;
  probeLength: (url: string) => Promise<AddonLengthProbe>;
  outputCapable: () => boolean;
  engine: () => AddonServiceEngine;
  isDownloaded: (trackId: string) => boolean;
  getDownloadedTrack: (trackId: string) => Track | undefined;
  clientFactory?: (source: AddonSourceConfig) => AddonClientLike;
  now?: () => number;
}

function healthForError(error: unknown): AddonHealth | null {
  if (!(error instanceof AddonRequestError)) return null;
  switch (error.kind) {
    case "rejected":
      return "rejected";
    case "rate-limited":
      return "rate-limited";
    case "unreachable":
    case "timeout":
    case "server":
      return "unreachable";
    default:
      return null;
  }
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function answerContentLength(answer: AddonStreamAnswer): number | undefined {
  const value = (answer as { contentLength?: unknown }).contentLength;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function sameOrigin(candidate: string, baseUrl: string): boolean {
  try {
    return new URL(candidate, baseUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function rowToRef(source: AddonSourceConfig, row: AddonSearchRow): AddonTrackRef {
  /* Same-origin artwork can embed the addon's secret path, which persisted rows must not. */
  const artworkUrl = row.artworkUrl !== undefined && !sameOrigin(row.artworkUrl, source.baseUrl)
    ? row.artworkUrl
    : undefined;
  return {
    sourceId: source.id,
    trackId: row.id,
    title: row.title,
    artist: row.artist ?? "",
    album: row.album,
    durationSec: row.durationSec,
    artworkUrl,
    format: row.format,
    streamUrl: row.streamUrl,
  };
}

function answerFromRow(row: CachedAddonRow): AddonStreamAnswer {
  return {
    url: row.streamUrl,
    format: row.format,
    mimeType: row.mimeType,
    codec: row.codec,
    container: row.container,
    sampleRate: row.sampleRateHz,
    bitDepth: row.bitDepth,
    bitrate: row.kbps,
    expiresAt: row.expiresAt,
  };
}

const STREAM_FAILURES: Record<string, string> = {
  url: "The addon returned an unusable stream URL.",
  encrypted: "The addon stream is encrypted and cannot be played.",
  transport: "The addon offered a stream format that is not supported (HLS or DASH).",
  format: "The addon offered an audio format that is not supported.",
  engine: "The selected audio engine cannot play this addon stream.",
};

function streamFailureMessage(reason: string): string {
  return STREAM_FAILURES[reason] ?? "The addon stream is not playable.";
}

export class AddonService {
  private readonly deps: AddonServiceDeps;
  private readonly clients = new Map<string, AddonClientLike>();

  constructor(deps: AddonServiceDeps) {
    this.deps = deps;
  }

  async addSource(label: string, rawUrl: string): Promise<AddonSourceConfig> {
    const source = await this.deps.registry.add(label, rawUrl);
    await this.probeSource(source.id);
    return this.deps.registry.get(source.id) ?? source;
  }

  async updateSource(id: string, patch: AddonSourcePatch): Promise<AddonSourceConfig> {
    await this.deps.registry.ensureLoaded();
    const before = this.deps.registry.get(id);
    const updated = await this.deps.registry.update(id, patch);
    this.invalidateSource(id);
    if (before !== undefined && before.baseUrl !== updated.baseUrl) {
      await this.deps.rows.forgetSource(id, this.deps.isDownloaded);
    }
    await this.probeSource(id);
    return this.deps.registry.get(id) ?? updated;
  }

  async removeSource(id: string): Promise<void> {
    await this.deps.registry.ensureLoaded();
    this.invalidateSource(id);
    await this.deps.registry.remove(id);
    await this.deps.rows.forgetSource(id, this.deps.isDownloaded);
  }

  async reorder(ids: string[]): Promise<void> {
    await this.deps.registry.reorder(ids);
  }

  async probeSource(id: string): Promise<AddonHealth> {
    const { registry } = this.deps;
    await registry.ensureLoaded();
    const source = registry.get(id);
    if (source === undefined) throw new Error("That addon source no longer exists.");
    if (this.isGated(source)) {
      await this.recordHealth(source, "gated");
      return "gated";
    }

    const client = this.clientFor(source);
    let manifest: AddonManifest | null;
    try {
      manifest = await client.getManifest({ bypassCache: true });
    } catch (error) {
      return this.recordFailure(id, error, "unreachable");
    }

    if (manifest === null) {
      try {
        await client.search("music", "high", { bypassCache: true });
      } catch (error) {
        return this.recordFailure(id, error, "unreachable");
      }
      await registry.recordProbe(id, "ok", null);
      return "ok";
    }

    const health: AddonHealth =
      manifest.checkValidLossless && !this.deps.outputCapable() ? "gated" : "ok";
    await registry.recordProbe(id, health, manifest);
    return health;
  }

  async search(query: string, quality: AudioQuality): Promise<Track[]> {
    const { registry } = this.deps;
    await registry.ensureLoaded();
    const sources = registry.list().filter((source) => this.isEligible(source));
    const settled = await Promise.allSettled(
      sources.map((source) => this.searchSource(source, query, quality)),
    );
    const tracks: Track[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled") tracks.push(...result.value);
    }
    return tracks;
  }

  async getTrack(id: string): Promise<Track> {
    const { registry, rows } = this.deps;
    await registry.ensureLoaded();
    if (!isAddonTrackId(id)) throw new Error("That track does not belong to an addon source.");

    const row = await rows.read(id);
    if (row === null) {
      const downloaded = this.deps.getDownloadedTrack(id);
      if (downloaded !== undefined) return downloaded;
      throw new Error("This addon track is no longer cached. Search again.");
    }

    const source = registry.get(row.sourceId);
    const current = source === undefined || source.baseUrl === ""
      ? null
      : await sourceFingerprint(source.baseUrl);
    if (current === null || current !== row.sourceFingerprint) {
      if (!this.deps.isDownloaded(id)) {
        throw new Error("This addon source changed or was removed. Search again.");
      }
      return this.deps.getDownloadedTrack(id) ?? await rows.toTrack(row);
    }
    return rows.toTrack(row);
  }

  async resolveTrack(
    track: Track,
    quality: AudioQuality,
    options: { engine?: AddonEngine } = {},
  ): Promise<ResolvedAddonStream> {
    const { registry, rows } = this.deps;
    await registry.ensureLoaded();
    const ref = track.addon;
    if (ref === undefined) throw new Error("That track does not belong to an addon source.");

    const source = registry.get(ref.sourceId);
    if (source === undefined || source.baseUrl === "") {
      throw new Error("That addon source is no longer configured.");
    }
    const fingerprint = await sourceFingerprint(source.baseUrl);
    const row = await rows.read(track.id);
    if (row === null || row.sourceFingerprint !== fingerprint) {
      throw new Error("This addon track is out of date. Search again.");
    }
    if (this.isGated(source)) {
      throw new Error("This addon source is gated until a lossless-capable output is available.");
    }

    const client = this.clientFor(source);
    let answer: AddonStreamAnswer;
    try {
      answer = await client.resolveStream(ref.trackId, quality);
    } catch (error) {
      if (error instanceof AddonRequestError && error.kind === "miss" && row.streamUrl !== undefined) {
        answer = answerFromRow(row);
      } else {
        throw error;
      }
    }

    const engine: AddonEngine = options.engine ?? this.effectiveEngine();
    const accepted = acceptAddonStream(answer, engine);
    if (!accepted.ok) throw new Error(streamFailureMessage(accepted.reason));
    const stream = accepted.stream;

    let contentLength = answerContentLength(answer);
    if (engine === "rust" && contentLength === undefined) {
      try {
        contentLength = (await this.deps.probeLength(stream.url)).contentLength;
      } catch {
        contentLength = undefined;
      }
    }

    const resolved: ResolvedAddonStream = {
      url: stream.url,
      mimeType: stream.mimeType,
      lossless: stream.lossless,
    };
    if (contentLength !== undefined) resolved.contentLength = contentLength;
    const codec = firstNonBlank(answer.codec, answer.fileCodec);
    if (codec !== undefined) resolved.codec = codec;
    if (stream.sampleRateHz !== undefined) resolved.sampleRateHz = stream.sampleRateHz;
    if (stream.bitDepth !== undefined) resolved.bitDepth = stream.bitDepth;
    if (stream.kbps !== undefined) resolved.kbps = stream.kbps;
    if (stream.expiresAtMs !== undefined) resolved.expiresAt = Math.floor(stream.expiresAtMs / 1000);
    return resolved;
  }

  allowDownloads(track: Track): boolean {
    const ref = track.addon;
    if (ref === undefined) return false;
    const source = this.deps.registry.get(ref.sourceId);
    if (source === undefined) return false;
    return source.allowDownloads && !this.isGated(source);
  }

  invalidateSource(id: string): void {
    const prefix = `${id}|`;
    for (const [key, client] of this.clients) {
      if (!key.startsWith(prefix)) continue;
      client.invalidate();
      this.clients.delete(key);
    }
  }

  private async searchSource(
    source: AddonSourceConfig,
    query: string,
    quality: AudioQuality,
  ): Promise<Track[]> {
    try {
      const rows = await this.clientFor(source).search(query, quality);
      const fingerprint = await sourceFingerprint(source.baseUrl);
      const refs = rows.map((row) => rowToRef(source, row));
      return await this.deps.rows.rememberMany(refs, fingerprint);
    } catch (error) {
      const health = healthForError(error);
      if (health !== null) await this.recordHealth(source, health);
      return [];
    }
  }

  private async recordFailure(
    id: string,
    error: unknown,
    fallback: AddonHealth,
  ): Promise<AddonHealth> {
    const source = this.deps.registry.get(id);
    const health = healthForError(error) ?? fallback;
    if (source === undefined) return health;
    await this.recordHealth(source, health);
    return health;
  }

  /**
   * Records health without discarding flags learned from a manifest. The registry resets
   * flags for a null manifest, which would drop a gate or a downloads restriction after a
   * transient failure, so the source's own manifest fields are handed back unchanged.
   */
  private async recordHealth(source: AddonSourceConfig, health: AddonHealth): Promise<void> {
    /* A concurrent probe may have learned stricter flags since the caller's snapshot. */
    const current = this.deps.registry.get(source.id) ?? source;
    const manifest: AddonManifest = {
      id: current.id,
      name: current.manifestName,
      version: current.manifestVersion,
      resources: [],
      settings: [],
      allowDownloads: current.allowDownloads,
      checkValidLossless: current.checkValidLossless,
    };
    await this.deps.registry.recordProbe(current.id, health, manifest);
  }

  private isEligible(source: AddonSourceConfig): boolean {
    return source.enabled
      && source.baseUrl !== ""
      && source.lastHealth !== "rejected"
      && !this.isGated(source);
  }

  private isGated(source: AddonSourceConfig): boolean {
    return source.checkValidLossless && !this.deps.outputCapable();
  }

  private effectiveEngine(): AddonEngine {
    return this.deps.engine() === "rust" ? "rust" : "native";
  }

  private clientFor(source: AddonSourceConfig): AddonClientLike {
    const key = `${source.id}|${source.baseUrl}`;
    const cached = this.clients.get(key);
    if (cached !== undefined) return cached;

    const factory = this.deps.clientFactory ?? ((next: AddonSourceConfig): AddonClientLike =>
      new AddonClient(next, { request: this.deps.request, now: this.deps.now }));
    const client = factory(source);
    this.clients.set(key, client);
    return client;
  }
}
