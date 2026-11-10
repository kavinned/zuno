import type { AudioQuality } from "../../internal/audioQuality";
import { logInternalInfo } from "../../internal/logging";
import type { Track } from "../types";
import { AddonClient, AddonRequestError, type AddonClientCallOptions } from "./client";
import { acceptAddonStream, type AddonEngine } from "./format";
import {
  rankAddonCandidates,
  type MatchCandidate,
  type MatchTarget,
} from "./matcher";
import type { AddonRegistry, AddonSourcePatch } from "./registry";
import type { AddonRowCache, CachedAddonRow } from "./rows";
import { buildSearchQueries, parseTrackTitle } from "./title";
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

export interface AddonSubstitutionMatch {
  track: Track;
  stream: ResolvedAddonStream;
}

export interface AddonSubstitutionOptions {
  engine?: AddonEngine;
  budgetMs?: number;
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
  probeLength: (url: string, sniffFlac?: boolean) => Promise<AddonLengthProbe>;
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

/** TorBox answers carry only `{ url, format: "flac" }`, so FLAC has to be recognised by name. */
function answerIsFlac(answer: AddonStreamAnswer): boolean {
  return [answer.format, answer.codec, answer.mimeType].some(
    (value) => typeof value === "string" && value.toLowerCase().includes("flac"),
  );
}

/** A stream's own size is a usable bitrate estimate when the addon does not state one. */
function deriveKbps(
  contentLength: number | undefined,
  durationSec: number | undefined,
): number | undefined {
  if (contentLength === undefined || durationSec === undefined) return undefined;
  if (!Number.isFinite(contentLength) || contentLength <= 0) return undefined;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return undefined;
  return Math.round((contentLength * 8) / 1000 / durationSec);
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

const SUBSTITUTION_BUDGET_MS = 2500;

async function withinDeadline<T>(
  work: Promise<T>,
  remainingMs: number,
  controller: AbortController,
): Promise<T | undefined> {
  if (remainingMs <= 0) {
    controller.abort();
    /* The work already started; without a handler a late rejection goes unhandled. */
    void work.catch(() => undefined);
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, remainingMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class AddonService {
  private readonly deps: AddonServiceDeps;
  private readonly clients = new Map<string, AddonClientLike>();
  /** Probe answers keyed by stream URL; a re-resolve of the same stream costs nothing extra. */
  private readonly probes = new Map<string, AddonLengthProbe>();

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
    options: { engine?: AddonEngine; signal?: AbortSignal } = {},
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
      answer = await client.resolveStream(ref.trackId, quality, { signal: options.signal });
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
    /*
     * A FLAC answer never states sample rate or bit depth, so one ranged sniff supplies them;
     * on the Rust engine the same request doubles as the missing content-length probe. Every
     * other format keeps the existing length-only probe, and only when Rust needs it.
     */
    const probe = answerIsFlac(answer)
      ? await this.probeStream(stream.url, true)
      : engine === "rust" && contentLength === undefined
        ? await this.probeStream(stream.url, false)
        : undefined;
    if (engine === "rust" && contentLength === undefined) {
      contentLength = probe?.contentLength;
    }

    const resolved: ResolvedAddonStream = {
      url: stream.url,
      mimeType: stream.mimeType,
      lossless: stream.lossless,
    };
    if (contentLength !== undefined) resolved.contentLength = contentLength;
    const codec = firstNonBlank(answer.codec, answer.fileCodec);
    if (codec !== undefined) resolved.codec = codec;
    const sampleRateHz = stream.sampleRateHz ?? probe?.sampleRateHz;
    if (sampleRateHz !== undefined) resolved.sampleRateHz = sampleRateHz;
    const bitDepth = stream.bitDepth ?? probe?.bitDepth;
    if (bitDepth !== undefined) resolved.bitDepth = bitDepth;
    const kbps = stream.kbps ?? deriveKbps(contentLength, track.durationSec);
    if (kbps !== undefined) resolved.kbps = kbps;
    if (stream.expiresAtMs !== undefined) resolved.expiresAt = Math.floor(stream.expiresAtMs / 1000);
    return resolved;
  }

  /**
   * Best-effort lossless substitution for a non-addon track: searches every eligible source
   * within one budget, ranks the rows, and resolves the first candidate that yields a
   * lossless stream. A miss is null, never an error.
   */
  async findLosslessMatch(
    target: Track,
    options: AddonSubstitutionOptions = {},
  ): Promise<AddonSubstitutionMatch | null> {
    const { registry, rows } = this.deps;
    await registry.ensureLoaded();
    const startedAt = Date.now();
    const deadline = startedAt + (options.budgetMs ?? SUBSTITUTION_BUDGET_MS);
    const sources = registry.list().filter((source) => this.isEligible(source));
    if (sources.length === 0) return null;

    const parts = parseTrackTitle(target.title);
    const queries = buildSearchQueries(parts, target.artists?.[0]?.name ?? target.artist);
    const matchTarget: MatchTarget = {
      title: target.title,
      artist: target.artist,
      artists: target.artists,
      album: target.album,
      durationSec: target.durationSec,
    };
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const fingerprints = new Map<string, string>();
    let best: { sourceId: string; score: number } | undefined;

    for (const query of queries) {
      if (Date.now() >= deadline) break;

      const searched = await Promise.all(
        sources.map(async (source) => ({
          source,
          found: await this.substitutionSearch(source, query, deadline),
        })),
      );
      const candidates: MatchCandidate[] = [];
      for (const { source, found } of searched) {
        for (const row of found) {
          candidates.push({ sourceId: source.id, sourceOrder: source.order, row });
        }
      }

      const skipped = new Set<string>();
      for (const { candidate, score } of rankAddonCandidates(matchTarget, candidates)) {
        if (Date.now() >= deadline) break;
        if (skipped.has(candidate.sourceId)) continue;
        if (best === undefined || score > best.score) {
          best = { sourceId: candidate.sourceId, score };
        }
        const source = sourceById.get(candidate.sourceId);
        if (source === undefined) continue;

        let fingerprint = fingerprints.get(source.id);
        if (fingerprint === undefined) {
          fingerprint = await sourceFingerprint(source.baseUrl);
          fingerprints.set(source.id, fingerprint);
        }
        const [track] = await rows.rememberMany([rowToRef(source, candidate.row)], fingerprint);

        const controller = new AbortController();
        let stream: ResolvedAddonStream | undefined;
        try {
          stream = await withinDeadline(
            this.resolveTrack(track, "lossless", {
              engine: options.engine,
              signal: controller.signal,
            }),
            deadline - Date.now(),
            controller,
          );
        } catch (error) {
          const kind = error instanceof AddonRequestError ? error.kind : undefined;
          if (
            kind === "rate-limited"
            || kind === "unreachable"
            || kind === "timeout"
            || kind === "server"
          ) {
            const health = healthForError(error);
            if (health !== null) await this.recordHealth(source, health);
            skipped.add(source.id);
          }
          continue;
        }
        if (stream === undefined) break;
        if (stream.lossless) return { track, stream };
      }
    }

    logInternalInfo("addon.substitution.miss", {
      sourceId: best?.sourceId,
      score: best?.score,
      elapsedMs: Date.now() - startedAt,
    });
    return null;
  }

  allowDownloads(track: Track): boolean {
    const ref = track.addon;
    if (ref === undefined) return false;
    const source = this.deps.registry.get(ref.sourceId);
    if (source === undefined) return false;
    return source.allowDownloads && !this.isGated(source);
  }

  invalidateSource(id: string): void {
    this.probes.clear();
    const prefix = `${id}|`;
    for (const [key, client] of this.clients) {
      if (!key.startsWith(prefix)) continue;
      client.invalidate();
      this.clients.delete(key);
    }
  }

  /** Best-effort and cached: a failed probe must never fail the stream. */
  private async probeStream(
    url: string,
    sniffFlac: boolean,
  ): Promise<AddonLengthProbe | undefined> {
    const cached = this.probes.get(url);
    if (cached !== undefined) return cached;
    try {
      const probe = await this.deps.probeLength(url, sniffFlac);
      this.probes.set(url, probe);
      return probe;
    } catch {
      return undefined;
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

  /** A substitution search never fails the attempt: a deadline hit or an error yields no rows. */
  private async substitutionSearch(
    source: AddonSourceConfig,
    query: string,
    deadline: number,
  ): Promise<AddonSearchRow[]> {
    const controller = new AbortController();
    try {
      const found = await withinDeadline(
        this.clientFor(source).search(query, "lossless", { signal: controller.signal }),
        deadline - Date.now(),
        controller,
      );
      return found ?? [];
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
