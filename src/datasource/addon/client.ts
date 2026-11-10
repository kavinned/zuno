import type { AudioQuality } from "../../internal/audioQuality";
import { normalizeExpiresAtMs } from "./format";
import {
  AddonManifestError,
  addonQualityParams,
  parseManifest,
  parseSearchResponse,
  parseStreamAnswer,
} from "./manifest";
import { tauriAddonRequest, type AddonRequest, type AddonRequestResult } from "./transport";
import type { AddonManifest, AddonSearchRow, AddonSourceConfig, AddonStreamAnswer } from "./types";
import { buildAddonSearchUrl, buildAddonStreamUrl } from "./url";

export type AddonRequestErrorKind =
  | "miss"
  | "rate-limited"
  | "unreachable"
  | "rejected"
  | "timeout"
  | "server"
  | "cancelled";

const REASONS: Record<AddonRequestErrorKind, string> = {
  miss: "The addon has no stream for this track.",
  "rate-limited": "The addon asked us to slow down.",
  unreachable: "The addon could not be reached.",
  rejected: "The addon response was not usable.",
  timeout: "The addon did not respond in time.",
  server: "The addon encountered an error.",
  cancelled: "The request was cancelled.",
};

export class AddonRequestError extends Error {
  readonly kind: AddonRequestErrorKind;
  readonly status?: number;

  constructor(kind: AddonRequestErrorKind, status?: number) {
    super(REASONS[kind]);
    this.name = "AddonRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export interface AddonClientOptions {
  request?: AddonRequest;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface AddonClientCallOptions {
  signal?: AbortSignal;
  bypassCache?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

const MANIFEST_KEY = "manifest";
const MANIFEST_TTL_MS = 10 * 60_000;
const SEARCH_TTL_MS = 10 * 60_000;
const STREAM_TTL_MS = 5 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const RETRY_DELAYS_MS = [500, 2000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_RETRY_AFTER_MS = 8000;

function retryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value.trim());
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : undefined;
}

function isTimeoutFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /timed?\s*out|timeout/i.test(message);
}

function serverFailureReason(status: number): AddonRequestErrorKind {
  return status >= 500 ? "server" : "rejected";
}

export class AddonClient {
  private readonly source: AddonSourceConfig;
  private readonly request: AddonRequest;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private rateLimitedUntil = 0;

  constructor(source: AddonSourceConfig, options: AddonClientOptions = {}) {
    this.source = source;
    this.request = options.request ?? tauriAddonRequest;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  isRateLimited(): boolean {
    return this.now() < this.rateLimitedUntil;
  }

  invalidate(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  async getManifest(options: AddonClientCallOptions = {}): Promise<AddonManifest | null> {
    this.throwIfCancelled(options.signal);
    this.assertNotRateLimited();
    if (!options.bypassCache) {
      const cached = this.readCache<AddonManifest | null>(MANIFEST_KEY);
      if (cached !== undefined) return cached;
    }
    return this.dedupe(MANIFEST_KEY, async () => {
      const url = `${this.source.baseUrl.replace(/\/+$/, "")}/manifest.json`;
      const response = await this.send(url, options.signal);
      const manifest = this.interpretManifest(response);
      this.writeCache(MANIFEST_KEY, manifest, MANIFEST_TTL_MS);
      return manifest;
    });
  }

  async search(
    query: string,
    quality: AudioQuality,
    options: AddonClientCallOptions = {},
  ): Promise<AddonSearchRow[]> {
    this.throwIfCancelled(options.signal);
    this.assertNotRateLimited();
    const key = `search:${quality}:${query}`;
    if (!options.bypassCache) {
      const cached = this.readCache<AddonSearchRow[]>(key);
      if (cached !== undefined) return cached;
    }
    return this.dedupe(key, async () => {
      const url = buildAddonSearchUrl(
        this.source.baseUrl,
        query,
        addonQualityParams(this.cachedManifest(), quality),
      );
      const response = await this.send(url, options.signal);
      const rows = this.interpretSearch(response);
      this.writeCache(key, rows, SEARCH_TTL_MS);
      return rows;
    });
  }

  async resolveStream(
    trackId: string,
    quality: AudioQuality,
    options: AddonClientCallOptions = {},
  ): Promise<AddonStreamAnswer> {
    this.throwIfCancelled(options.signal);
    this.assertNotRateLimited();
    const key = `stream:${quality}:${trackId}`;
    if (!options.bypassCache) {
      const cached = this.readCache<AddonStreamAnswer>(key);
      if (cached !== undefined) return cached;
    }
    return this.dedupe(key, async () => {
      const url = buildAddonStreamUrl(
        this.source.baseUrl,
        trackId,
        addonQualityParams(this.cachedManifest(), quality),
      );
      const response = await this.send(url, options.signal);
      const answer = this.interpretStream(response);
      const expiresAtMs = normalizeExpiresAtMs(answer.expiresAt);
      const ttl = expiresAtMs === undefined
        ? STREAM_TTL_MS
        : Math.min(STREAM_TTL_MS, expiresAtMs - this.now() - EXPIRY_MARGIN_MS);
      this.writeCache(key, answer, ttl);
      return answer;
    });
  }

  private interpretManifest(response: AddonRequestResult): AddonManifest | null {
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new AddonRequestError(serverFailureReason(response.status), response.status);
    }
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      return null;
    }
    try {
      return parseManifest(value);
    } catch (error) {
      if (error instanceof AddonManifestError) {
        throw new AddonRequestError("rejected", response.status);
      }
      throw error;
    }
  }

  private interpretSearch(response: AddonRequestResult): AddonSearchRow[] {
    if (response.status !== 200) {
      throw new AddonRequestError(serverFailureReason(response.status), response.status);
    }
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new AddonRequestError("rejected", response.status);
    }
    return parseSearchResponse(value);
  }

  private interpretStream(response: AddonRequestResult): AddonStreamAnswer {
    if (response.status >= 400 && response.status < 500) {
      throw new AddonRequestError("miss", response.status);
    }
    if (response.status !== 200) {
      throw new AddonRequestError(serverFailureReason(response.status), response.status);
    }
    let value: unknown;
    try {
      value = JSON.parse(response.body);
    } catch {
      throw new AddonRequestError("rejected", response.status);
    }
    const answer = parseStreamAnswer(value);
    if (typeof answer.url !== "string" || answer.url.trim() === "") {
      throw new AddonRequestError("miss", response.status);
    }
    return answer;
  }

  private async send(url: string, signal: AbortSignal | undefined): Promise<AddonRequestResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      this.throwIfCancelled(signal);
      let response: AddonRequestResult;
      try {
        response = await this.request({ url });
      } catch (error) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new AddonRequestError(isTimeoutFailure(error) ? "timeout" : "unreachable");
        }
        await this.sleepThenCheck(retryDelay(attempt), signal);
        continue;
      }

      if (response.status === 429) {
        const delay = retryAfterMs(response.retryAfter) ?? retryDelay(attempt);
        this.rateLimitedUntil = this.now() + delay;
        if (attempt === MAX_ATTEMPTS - 1) throw new AddonRequestError("rate-limited", 429);
        await this.sleepThenCheck(delay, signal);
        continue;
      }

      if (response.status >= 500) {
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new AddonRequestError("server", response.status);
        }
        await this.sleepThenCheck(retryDelay(attempt), signal);
        continue;
      }

      return response;
    }
    throw new AddonRequestError("unreachable");
  }

  private async sleepThenCheck(ms: number, signal: AbortSignal | undefined): Promise<void> {
    await this.sleep(ms);
    this.throwIfCancelled(signal);
  }

  private throwIfCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new AddonRequestError("cancelled");
  }

  private assertNotRateLimited(): void {
    if (this.now() < this.rateLimitedUntil) {
      throw new AddonRequestError("rate-limited", 429);
    }
  }

  private readCache<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  private writeCache(key: string, value: unknown, ttlMs: number): void {
    this.cache.set(key, { expiresAt: this.now() + ttlMs, value });
  }

  private cachedManifest(): AddonManifest | null {
    return this.readCache<AddonManifest | null>(MANIFEST_KEY) ?? null;
  }

  private dedupe<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = work().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}
