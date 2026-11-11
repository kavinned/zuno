export {};

import type { AudioQuality } from "../../internal/audioQuality";
import type { Track } from "../types";
import { AddonRequestError, type AddonClientCallOptions } from "./client";
import { AddonRegistry } from "./registry";
import type { CachedAddonRow } from "./rows";
import {
  AddonService,
  type AddonClientLike,
  type AddonServiceRows,
} from "./service";
import {
  parseAddonSources,
  type AddonRegistryStorage,
  type AddonSecretStore,
} from "./storage";
import type {
  AddonHealth,
  AddonManifest,
  AddonSearchRow,
  AddonSourceConfig,
  AddonStreamAnswer,
  AddonTrackRef,
  PersistedAddonSource,
} from "./types";
import { addonCompositeId, sourceFingerprint } from "./url";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

async function expectReject(
  run: () => Promise<unknown>,
  needle: string,
  message: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    check(
      text.toLowerCase().includes(needle.toLowerCase()),
      `${message}: "${text}" does not mention "${needle}"`,
    );
    return;
  }
  throw new Error(`FAILED: ${message}: did not throw`);
}

class MemoryStorage implements AddonRegistryStorage {
  private raw: unknown;

  constructor(raw: unknown = null) {
    this.raw = raw;
  }

  async read(): Promise<PersistedAddonSource[]> {
    return parseAddonSources(this.raw);
  }

  async write(sources: PersistedAddonSource[]): Promise<void> {
    this.raw = { version: 1, sources };
  }
}

class MemorySecrets implements AddonSecretStore {
  private readonly values = new Map<string, string>();

  async get(sourceId: string): Promise<string | null> {
    return this.values.get(sourceId) ?? null;
  }

  async set(sourceId: string, value: string): Promise<void> {
    this.values.set(sourceId, value);
  }

  async delete(sourceId: string): Promise<void> {
    this.values.delete(sourceId);
  }
}

type TestStreamAnswer = AddonStreamAnswer & { contentLength?: number };

interface Script {
  manifest?: AddonManifest | null;
  manifestError?: Error;
  searchResult?: AddonSearchRow[];
  searchError?: Error;
  streamAnswer?: (trackId: string) => TestStreamAnswer;
  streamError?: (trackId: string) => Error | undefined;
}

class FakeClient implements AddonClientLike {
  readonly searchQueries: string[] = [];
  readonly searchQualities: AudioQuality[] = [];
  readonly searchOptions: Array<AddonClientCallOptions | undefined> = [];
  getManifestCalls = 0;
  searchCalls = 0;
  streamCalls = 0;
  invalidations = 0;

  constructor(readonly sourceId: string, private readonly script: Script) {}

  async getManifest(_options?: AddonClientCallOptions): Promise<AddonManifest | null> {
    this.getManifestCalls += 1;
    if (this.script.manifestError !== undefined) throw this.script.manifestError;
    return this.script.manifest ?? null;
  }

  async search(
    query: string,
    quality: AudioQuality,
    options?: AddonClientCallOptions,
  ): Promise<AddonSearchRow[]> {
    this.searchCalls += 1;
    this.searchQueries.push(query);
    this.searchQualities.push(quality);
    this.searchOptions.push(options);
    if (this.script.searchError !== undefined) throw this.script.searchError;
    return this.script.searchResult ?? [];
  }

  async resolveStream(
    trackId: string,
    _quality: AudioQuality,
    _options?: AddonClientCallOptions,
  ): Promise<AddonStreamAnswer> {
    this.streamCalls += 1;
    const error = this.script.streamError?.(trackId);
    if (error !== undefined) throw error;
    return this.script.streamAnswer?.(trackId) ?? {};
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

class FakeRows implements AddonServiceRows {
  readonly rows = new Map<string, CachedAddonRow>();
  readonly remembers: Array<{ refs: AddonTrackRef[]; fingerprint: string }> = [];
  readonly forgotten: Array<{
    sourceId: string;
    isProtected?: (trackId: string) => boolean;
  }> = [];

  async rememberMany(refs: AddonTrackRef[], fingerprint: string): Promise<Track[]> {
    this.remembers.push({ refs, fingerprint });
    const tracks: Track[] = [];
    for (const ref of refs) {
      const id = await addonCompositeId(ref.sourceId, ref.trackId);
      const row: CachedAddonRow = { ...ref, sourceFingerprint: fingerprint, cachedAt: 0 };
      this.rows.set(id, row);
      tracks.push({
        id,
        source: "addon",
        title: ref.title,
        artist: ref.artist,
        album: ref.album,
        artworkUrl: ref.artworkUrl,
        addon: ref,
      });
    }
    return tracks;
  }

  async read(trackId: string): Promise<CachedAddonRow | null> {
    return this.rows.get(trackId) ?? null;
  }

  async forgetSource(
    sourceId: string,
    isProtected?: (trackId: string) => boolean,
  ): Promise<void> {
    this.forgotten.push({ sourceId, isProtected });
    for (const [id, row] of this.rows) {
      if (row.sourceId !== sourceId) continue;
      if (isProtected?.(id) === true) continue;
      this.rows.delete(id);
    }
  }

  async toTrack(row: CachedAddonRow): Promise<Track> {
    return {
      id: await addonCompositeId(row.sourceId, row.trackId),
      source: "addon",
      title: row.title,
      artist: row.artist,
      album: row.album,
      artworkUrl: row.artworkUrl,
      addon: row,
    };
  }
}

interface SeedSource {
  id: string;
  baseUrl: string;
  label?: string;
  order?: number;
  enabled?: boolean;
  allowDownloads?: boolean;
  checkValidLossless?: boolean;
  lastHealth?: AddonHealth;
}

interface SetupOptions {
  sources: SeedSource[];
  script?: (source: AddonSourceConfig) => Script;
  outputCapable?: boolean;
  engine?: "rust" | "native" | "iframe";
  downloaded?: Set<string>;
  downloadedTracks?: Map<string, Track>;
  probeLength?: (
    url: string,
    sniffFlac?: boolean,
  ) => Promise<{
    contentLength?: number;
    acceptsRanges: boolean;
    sampleRateHz?: number;
    bitDepth?: number;
  }>;
  clientFactory?: (source: AddonSourceConfig) => AddonClientLike;
  now?: () => number;
}

interface Harness {
  service: AddonService;
  registry: AddonRegistry;
  rows: FakeRows;
  created: FakeClient[];
}

async function setup(options: SetupOptions): Promise<Harness> {
  const persisted = options.sources.map((source, index) => ({
    id: source.id,
    label: source.label ?? source.id,
    enabled: source.enabled ?? true,
    order: source.order ?? index,
    allowDownloads: source.allowDownloads ?? true,
    checkValidLossless: source.checkValidLossless ?? false,
    ...(source.lastHealth === undefined ? {} : { lastHealth: source.lastHealth }),
  }));
  const storage = new MemoryStorage({ version: 1, sources: persisted });
  const secrets = new MemorySecrets();
  for (const source of options.sources) await secrets.set(source.id, source.baseUrl);

  const registry = new AddonRegistry(storage, secrets);
  await registry.ensureLoaded();
  const rows = new FakeRows();
  const created: FakeClient[] = [];
  const scriptFor = options.script ?? (() => ({}));
  const clientsById = new Map<string, FakeClient>();
  const defaultFactory = (source: AddonSourceConfig): AddonClientLike => {
    const key = `${source.id}|${source.baseUrl}`;
    const existing = clientsById.get(key);
    if (existing !== undefined) return existing;
    const client = new FakeClient(source.id, scriptFor(source));
    clientsById.set(key, client);
    created.push(client);
    return client;
  };

  const service = new AddonService({
    registry,
    rows,
    request: async () => ({ status: 200, body: "{}" }),
    probeLength: options.probeLength ?? (async () => ({ acceptsRanges: true })),
    outputCapable: () => options.outputCapable ?? true,
    engine: () => options.engine ?? "native",
    isDownloaded: (trackId) => options.downloaded?.has(trackId) === true,
    getDownloadedTrack: (trackId) => options.downloadedTracks?.get(trackId),
    clientFactory: options.clientFactory ?? defaultFactory,
    now: options.now ?? (() => 0),
  });

  /* A check may override a fake client's methods before the first service call, so every
     source the service would contact gets its client up front; nothing is called yet. */
  if (options.clientFactory === undefined) {
    const outputCapable = options.outputCapable ?? true;
    for (const source of registry.list()) {
      const gated = source.checkValidLossless && !outputCapable;
      if (source.enabled && source.baseUrl !== "" && source.lastHealth !== "rejected" && !gated) {
        defaultFactory(source);
      }
    }
  }

  return { service, registry, rows, created };
}

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";
const SOURCE_C = "33333333-3333-4333-8333-333333333333";

function manifest(overrides: Partial<AddonManifest> = {}): AddonManifest {
  return {
    id: "test-addon",
    name: "Test Addon",
    version: "1.0.0",
    resources: ["search"],
    settings: [],
    allowDownloads: true,
    checkValidLossless: false,
    ...overrides,
  };
}

function searchRow(overrides: Partial<AddonSearchRow> = {}): AddonSearchRow {
  return { id: "tidal:1", title: "Gehra Hua", artist: "Test Artist", ...overrides };
}

async function addonTrack(sourceId: string, trackId: string): Promise<Track> {
  return {
    id: await addonCompositeId(sourceId, trackId),
    source: "addon",
    title: "T",
    artist: "A",
    addon: { sourceId, trackId, title: "T", artist: "A" },
  };
}

async function putRow(
  rows: FakeRows,
  sourceId: string,
  trackId: string,
  fingerprint: string,
  extra: Partial<CachedAddonRow> = {},
): Promise<string> {
  const id = await addonCompositeId(sourceId, trackId);
  rows.rows.set(id, {
    sourceId,
    trackId,
    title: "Row",
    artist: "Artist",
    sourceFingerprint: fingerprint,
    cachedAt: 0,
    ...extra,
  });
  return id;
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://gated.example/secret";
  const fingerprint = await sourceFingerprint(baseUrl);
  let factoryCalls = 0;
  const spy = new FakeClient(sourceId, {});
  const { service, registry, rows } = await setup({
    sources: [{ id: sourceId, baseUrl, checkValidLossless: true }],
    outputCapable: false,
    clientFactory: () => {
      factoryCalls += 1;
      return spy;
    },
  });

  equal(await service.probeSource(sourceId), "gated", "gated probe reports gated");
  equal(registry.get(sourceId)?.lastHealth, "gated", "gated probe records health");
  equal(factoryCalls, 0, "gated probe builds no client");
  equal((await service.search("gehra", "high")).length, 0, "gated search returns nothing");
  equal(factoryCalls, 0, "gated search builds no client");
  equal(spy.searchCalls, 0, "gated source was never contacted");

  const trackId = await putRow(rows, sourceId, "tidal:1", fingerprint);
  const track: Track = {
    id: trackId,
    source: "addon",
    title: "T",
    artist: "A",
    addon: { sourceId, trackId: "tidal:1", title: "T", artist: "A" },
  };
  await expectReject(() => service.resolveTrack(track, "high"), "gated", "gated resolve throws");
  equal(spy.searchCalls, 0, "gated source was never contacted by resolve");
  equal(spy.streamCalls, 0, "gated resolve makes no stream call");
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://capable.example/secret";
  const { service, registry } = await setup({
    sources: [{ id: sourceId, baseUrl, checkValidLossless: true }],
    outputCapable: true,
    script: () => ({
      manifest: manifest({ checkValidLossless: true }),
      searchResult: [searchRow()],
      streamAnswer: () => ({
        url: "https://cdn.example/a.flac",
        format: "flac",
        sampleRate: 44100,
        bitrate: 900000,
      }),
    }),
  });

  equal(await service.probeSource(sourceId), "ok", "capable probe is ok");
  equal(registry.get(sourceId)?.checkValidLossless, true, "capable probe records the manifest flag");
  const tracks = await service.search("gehra", "high");
  equal(tracks.length, 1, "capable search returns rows");
  const stream = await service.resolveTrack(tracks[0], "high");
  equal(stream.url, "https://cdn.example/a.flac", "capable resolve returns the URL");
  equal(stream.lossless, true, "flac is lossless");
  equal(stream.sampleRateHz, 44100, "sample rate normalized");
  equal(stream.kbps, 900, "bitrate normalized to kbps");
}

{
  const sourceId = SOURCE_A;
  const { service, registry, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://nosearch.example/secret" }],
    script: () => ({ manifest: null, searchResult: [] }),
  });

  equal(await service.probeSource(sourceId), "ok", "empty search probe is ok");
  equal(registry.get(sourceId)?.lastHealth, "ok", "empty search probe records ok");
  equal(created.length, 1, "probe built one client");
  equal(created[0].getManifestCalls, 1, "probe fetched the manifest once");
  equal(created[0].searchCalls, 1, "probe searched once");
  equal(created[0].searchQueries[0], "music", "probe queries music");
  equal(created[0].searchOptions[0]?.bypassCache, true, "probe search bypasses the cache");
}

{
  const sourceId = SOURCE_A;
  const { service, registry, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://rejected.example/secret" }],
    script: () => ({ manifestError: new AddonRequestError("rejected", 200) }),
  });

  equal(await service.probeSource(sourceId), "rejected", "rejected manifest records rejected");
  equal(registry.get(sourceId)?.lastHealth, "rejected", "rejected health stored");
  equal(created[0].searchCalls, 0, "rejected manifest is not retried as a search probe");
}

for (const [error, expected] of [
  [new AddonRequestError("rejected", 404), "rejected"],
  [new AddonRequestError("rate-limited", 429), "rate-limited"],
  [new AddonRequestError("server", 503), "unreachable"],
  [new AddonRequestError("timeout"), "unreachable"],
] as const) {
  const sourceId = SOURCE_A;
  const { service, registry, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://probe.example/secret" }],
    script: () => ({ manifest: null, searchError: error }),
  });

  equal(await service.probeSource(sourceId), expected, `probe maps ${error.kind} to ${expected}`);
  equal(registry.get(sourceId)?.enabled, true, `${error.kind} leaves the source enabled`);
  equal(created[0].searchCalls, 1, `${error.kind} search probe made one call`);
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://stale-flags.example/secret";
  const { service, registry, created } = await setup({
    sources: [{ id: sourceId, baseUrl, allowDownloads: true, checkValidLossless: false }],
    outputCapable: false,
    script: () => ({
      manifest: manifest({ allowDownloads: true, checkValidLossless: false }),
    }),
  });

  await service.probeSource(sourceId);
  equal(created.length, 1, "the probe built the client");
  let searchCalls = 0;
  created[0].search = async () => {
    searchCalls += 1;
    // A concurrent probe learns stricter flags while this search is in flight.
    await registry.recordProbe(
      sourceId,
      "gated",
      manifest({ allowDownloads: false, checkValidLossless: true }),
    );
    throw new AddonRequestError("server", 503);
  };

  const tracks = await service.search("q", "high");
  equal(tracks.length, 0, "the failing search returns nothing");
  equal(registry.get(sourceId)?.lastHealth, "unreachable", "the failure is recorded");
  equal(
    registry.get(sourceId)?.checkValidLossless,
    true,
    "the stale snapshot does not clear the gate",
  );
  equal(
    registry.get(sourceId)?.allowDownloads,
    false,
    "the stale snapshot does not restore the downloads restriction",
  );

  await service.search("q2", "high");
  equal(searchCalls, 1, "the gated source is not contacted after the failure");
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://rows.example/secret";
  const { service, rows } = await setup({
    sources: [{ id: sourceId, baseUrl }],
    script: () => ({
      manifest: manifest(),
      searchResult: [
        searchRow({ id: "tidal:1", artworkUrl: `${baseUrl}/art/1.jpg` }),
        searchRow({
          id: "tidal:2",
          title: "Second",
          artworkUrl: "https://cdn.example/art.jpg",
        }),
      ],
    }),
  });

  const tracks = await service.search("gehra", "high");
  equal(tracks.length, 2, "both rows returned");
  equal(rows.remembers.length, 1, "rows are remembered before returning");
  const refs = rows.remembers[0].refs;
  equal(refs.length, 2, "both refs remembered");
  equal(refs[0].trackId, "tidal:1", "track id mapped");
  equal(refs[0].artworkUrl, undefined, "same-origin artwork stripped");
  equal(refs[1].artworkUrl, "https://cdn.example/art.jpg", "cross-origin artwork kept");
  equal(refs[1].title, "Second", "row order preserved");
  equal(
    rows.remembers[0].fingerprint,
    await sourceFingerprint(baseUrl),
    "row fingerprint is the source fingerprint",
  );

  const expectedId = await addonCompositeId(sourceId, "tidal:1");
  equal(tracks[0].id, expectedId, "composite id");
  check(/^addon\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}$/.test(tracks[0].id), "id is safe");
  check(!tracks[0].id.includes("tidal"), "raw track id is not leaked into the composite id");
  check(!tracks[0].id.includes("secret"), "base URL is not leaked into the composite id");
  const stored = await rows.read(tracks[0].id);
  check(stored !== null, "row written before returning");
  equal(stored?.artworkUrl, undefined, "same-origin artwork not persisted");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://missing.example/secret" }],
  });

  await expectReject(
    () => service.getTrack(`addon.${sourceId}.AAAAAAAAAAAAAAAAAAAAAA`),
    "Search again",
    "missing row throws",
  );
  await expectReject(() => service.getTrack("youtube:abc"), "addon", "non-addon id throws");
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://removed.example/secret";
  const downloaded = new Set<string>();
  const downloadedTracks = new Map<string, Track>();
  const { service, registry } = await setup({
    sources: [{ id: sourceId, baseUrl }],
    downloaded,
    downloadedTracks,
    script: () => ({ manifest: manifest(), searchResult: [searchRow()] }),
  });

  const [track] = await service.search("q", "high");
  await registry.remove(sourceId);
  await expectReject(
    () => service.getTrack(track.id),
    "Search again",
    "removed source throws without a download",
  );

  downloaded.add(track.id);
  equal(
    (await service.getTrack(track.id)).title,
    track.title,
    "removed source returns the row for a downloaded track",
  );

  downloadedTracks.set(track.id, {
    id: track.id,
    source: "addon",
    title: "Downloaded",
    artist: "Artist",
    localPath: "/offline/x",
  });
  equal(
    (await service.getTrack(track.id)).title,
    "Downloaded",
    "removed source prefers the downloaded track",
  );
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://changed.example/secret";
  const downloaded = new Set<string>();
  const { service, registry } = await setup({
    sources: [{ id: sourceId, baseUrl }],
    downloaded,
    script: () => ({ manifest: manifest(), searchResult: [searchRow()] }),
  });

  const [track] = await service.search("q", "high");
  await registry.update(sourceId, { baseUrl: "https://changed.example/other" });
  await expectReject(
    () => service.getTrack(track.id),
    "Search again",
    "changed base URL throws without a download",
  );

  downloaded.add(track.id);
  equal(
    (await service.getTrack(track.id)).title,
    track.title,
    "changed base URL returns the row for a downloaded track",
  );
}

{
  const sourceId = SOURCE_A;
  const oldUrl = "https://old.example/secret";
  const downloaded = new Set<string>();
  const { service, registry, rows, created } = await setup({
    sources: [{ id: sourceId, baseUrl: oldUrl }],
    downloaded,
    script: () => ({ manifest: manifest(), searchResult: [searchRow()] }),
  });

  const [track] = await service.search("q", "high");
  const keptId = track.id;
  const forgottenCandidate = await putRow(
    rows,
    sourceId,
    "tidal:2",
    await sourceFingerprint(oldUrl),
  );
  downloaded.add(keptId);
  const clientsBefore = created.length;

  await service.updateSource(sourceId, { baseUrl: "https://new.example/other" });
  equal(registry.get(sourceId)?.baseUrl, "https://new.example/other", "new URL stored");
  equal(rows.forgotten.length, 1, "rows forgotten once");
  equal(rows.forgotten[0].sourceId, sourceId, "forgot the right source");
  equal(rows.forgotten[0].isProtected?.(keptId), true, "downloaded row protected");
  equal(
    rows.forgotten[0].isProtected?.(forgottenCandidate),
    false,
    "undownloaded row not protected",
  );
  check(rows.rows.has(keptId), "downloaded row survives the URL change");
  check(!rows.rows.has(forgottenCandidate), "undownloaded row forgotten");
  check(created.length > clientsBefore, "client cache dropped for the new URL");
  equal(created[0].invalidations, 1, "the old client was invalidated");
  equal(created[created.length - 1].getManifestCalls, 1, "the source was probed after the update");

  await service.updateSource(sourceId, { label: "Renamed" });
  equal(rows.forgotten.length, 1, "label-only update keeps the rows");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://hls.example/secret" }],
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow()],
      streamAnswer: () => ({
        url: "https://cdn.example/live.m3u8",
        mimeType: "application/vnd.apple.mpegurl",
      }),
    }),
  });

  const [track] = await service.search("q", "high");
  await expectReject(() => service.resolveTrack(track, "high"), "not supported", "HLS is rejected");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://miss.example/secret" }],
    script: () => ({
      manifest: manifest(),
      searchResult: [
        searchRow({ streamUrl: "https://cdn.example/fallback.mp3", format: "mp3" }),
      ],
      streamError: () => new AddonRequestError("miss", 404),
    }),
  });

  const [track] = await service.search("q", "high");
  const stream = await service.resolveTrack(track, "high");
  equal(stream.url, "https://cdn.example/fallback.mp3", "miss falls back to the row stream URL");
  equal(stream.mimeType, "audio/mpeg", "fallback format maps to a MIME type");
  equal(stream.lossless, false, "mp3 is not lossless");
}

{
  const sourceId = SOURCE_A;
  const baseUrl = "https://rust.example/secret";
  const probed: Array<{ url: string; sniff: boolean }> = [];
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl }],
    engine: "rust",
    probeLength: async (url, sniffFlac = false) => {
      probed.push({ url, sniff: sniffFlac });
      return { contentLength: 4321, acceptsRanges: true };
    },
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow({ id: "tidal:1" }), searchRow({ id: "tidal:2" })],
      streamAnswer: (trackId) => trackId === "tidal:2"
        ? { url: "https://cdn.example/b.mp3", format: "mp3", contentLength: 999 }
        : { url: "https://cdn.example/a.flac", format: "flac", expiresAt: 1767225600 },
    }),
  });

  const tracks = await service.search("q", "high");
  const first = await service.resolveTrack(tracks[0], "high");
  equal(first.contentLength, 4321, "rust engine probes a missing content length");
  equal(probed[0].url, "https://cdn.example/a.flac", "the probe targets the stream URL");
  equal(probed[0].sniff, true, "a flac answer is sniffed for audio info");
  equal(first.expiresAt, 1767225600, "expiry converted to seconds");

  const second = await service.resolveTrack(tracks[1], "high");
  equal(second.contentLength, 999, "an answer content length is used as-is");
  equal(probed.length, 1, "a present content length is not probed");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://rust-fail.example/secret" }],
    engine: "rust",
    probeLength: async () => {
      throw new Error("probe failed");
    },
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac" }),
    }),
  });

  const [track] = await service.search("q", "high");
  const stream = await service.resolveTrack(track, "high");
  equal(stream.url, "https://cdn.example/a.flac", "a failed probe does not reject the stream");
  equal(stream.contentLength, undefined, "a failed probe leaves the content length undefined");
}

{
  const sourceId = SOURCE_A;
  const probed: Array<{ url: string; sniff: boolean }> = [];
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://native.example/secret" }],
    engine: "native",
    probeLength: async (url, sniffFlac = false) => {
      probed.push({ url, sniff: sniffFlac });
      return { contentLength: 4321, acceptsRanges: true };
    },
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac" }),
    }),
  });

  const [track] = await service.search("q", "high");
  const stream = await service.resolveTrack(track, "high");
  equal(probed.length, 1, "native flac playback still sniffs audio info");
  equal(probed[0].sniff, true, "the native sniff asks for flac metadata");
  equal(stream.contentLength, undefined, "native playback has no content length");
}

{
  const sourceId = SOURCE_A;
  const probeCalls: Array<{ url: string; sniff: boolean }> = [];
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://flac-info.example/secret" }],
    engine: "rust",
    probeLength: async (url, sniffFlac = false) => {
      probeCalls.push({ url, sniff: sniffFlac });
      return {
        contentLength: 10_000_000,
        acceptsRanges: true,
        sampleRateHz: 44_100,
        bitDepth: 24,
      };
    },
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac" }),
    }),
  });

  const [track] = await service.search("q", "high");
  const timedTrack: Track = { ...track, durationSec: 200 };
  const stream = await service.resolveTrack(timedTrack, "high");
  equal(probeCalls.length, 1, "a flac answer is sniffed once");
  equal(probeCalls[0].sniff, true, "the sniff is opt-in");
  equal(stream.sampleRateHz, 44_100, "sample rate comes from the sniff");
  equal(stream.bitDepth, 24, "bit depth comes from the sniff");
  equal(stream.contentLength, 10_000_000, "rust takes its missing length from the same request");
  equal(stream.kbps, 400, "bitrate is derived from length and duration");

  await service.resolveTrack(timedTrack, "high");
  equal(probeCalls.length, 1, "a repeated resolve reuses the cached probe");

  service.invalidateSource(sourceId);
  await service.resolveTrack(timedTrack, "high");
  equal(probeCalls.length, 2, "invalidating the source clears the probe cache");
}

{
  const sourceId = SOURCE_A;
  const probeCalls: boolean[] = [];
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://mp3-info.example/secret" }],
    engine: "rust",
    probeLength: async (_url, sniffFlac = false) => {
      probeCalls.push(sniffFlac);
      return { contentLength: 4321, acceptsRanges: true };
    },
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow()],
      streamAnswer: () => ({
        url: "https://cdn.example/a.mp3",
        format: "mp3",
        sampleRate: 44_100,
      }),
    }),
  });

  const [track] = await service.search("q", "high");
  const stream = await service.resolveTrack(track, "high");
  equal(probeCalls.length, 1, "a non-flac stream is probed for its length");
  equal(probeCalls[0], false, "a non-flac stream is not sniffed");
  equal(stream.sampleRateHz, 44_100, "answer metadata is kept when no sniff runs");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://iframe.example/secret" }],
    engine: "iframe",
    script: () => ({
      manifest: manifest(),
      searchResult: [searchRow()],
      streamAnswer: () => ({
        url: "https://cdn.example/a.m4a",
        mimeType: "audio/mp4",
        codec: "alac",
      }),
    }),
  });

  const [track] = await service.search("q", "high");
  await expectReject(
    () => service.resolveTrack(track, "high"),
    "engine",
    "iframe maps to native and refuses ALAC",
  );
}

{
  const sourceId = SOURCE_A;
  const track = await addonTrack(sourceId, "tidal:1");

  const denied = await setup({
    sources: [{ id: sourceId, baseUrl: "https://denied.example/secret", allowDownloads: false }],
  });
  equal(denied.service.allowDownloads(track), false, "the source flag denies downloads");

  const allowed = await setup({
    sources: [{ id: sourceId, baseUrl: "https://allowed.example/secret" }],
  });
  equal(allowed.service.allowDownloads(track), true, "the source flag allows downloads");

  const gated = await setup({
    sources: [{
      id: sourceId,
      baseUrl: "https://gated-downloads.example/secret",
      checkValidLossless: true,
    }],
    outputCapable: false,
  });
  equal(gated.service.allowDownloads(track), false, "the output gate denies downloads");

  const other: Track = { id: "youtube:abc", source: "youtube", title: "T", artist: "A" };
  equal(allowed.service.allowDownloads(other), false, "non-addon tracks never use addon downloads");
}

{
  const failingId = SOURCE_A;
  const healthyId = SOURCE_B;
  const disabledId = SOURCE_C;
  const scripts = new Map<string, Script>();
  const { service, registry, created } = await setup({
    sources: [
      { id: failingId, baseUrl: "https://fail.example/secret", order: 0 },
      { id: healthyId, baseUrl: "https://ok.example/secret", order: 1 },
      { id: disabledId, baseUrl: "https://off.example/secret", order: 2, enabled: false },
    ],
    script: (source) => {
      const existing = scripts.get(source.id);
      if (existing !== undefined) return existing;
      const script: Script = source.id === failingId
        ? { searchError: new AddonRequestError("server", 503) }
        : { searchResult: [searchRow({ id: `row-${source.id}` })] };
      scripts.set(source.id, script);
      return script;
    },
  });

  const first = await service.search("q", "high");
  equal(first.length, 1, "a failing source does not fail the search");
  equal(first[0].addon?.sourceId, healthyId, "healthy source rows are returned");
  equal(registry.get(failingId)?.lastHealth, "unreachable", "5xx records unreachable");
  equal(registry.get(failingId)?.enabled, true, "5xx does not disable the source");
  equal(
    created.some((client) => client.sourceId === disabledId),
    false,
    "a disabled source is not contacted",
  );

  scripts.get(failingId)!.searchError = undefined;
  scripts.get(failingId)!.searchResult = [searchRow({ id: "recovered" })];
  const second = await service.search("again", "high");
  equal(second.length, 2, "a recovered source is searched again");
  equal(second[0].addon?.sourceId, failingId, "source order is preserved");
}

const youtubeTarget: Track = {
  id: "yt-target",
  source: "youtube",
  title: 'Gehra Hua (From "Dhurandhar")',
  artist: "Arijit Singh",
  album: "Dhurandhar",
  durationSec: 362,
};

function matchRow(overrides: Partial<AddonSearchRow> = {}): AddonSearchRow {
  return searchRow({
    title: "Gehra Hua",
    artist: "Arijit Singh",
    album: "Dhurandhar",
    durationSec: 362,
    format: "flac",
    ...overrides,
  });
}

{
  const sourceId = SOURCE_A;
  const { service, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://match.example/secret" }],
    script: () => ({
      searchResult: [matchRow({ id: "tidal:1" })],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac", sampleRate: 44100 }),
    }),
  });

  const match = await service.findLosslessMatch(youtubeTarget);
  check(match !== null, "a lossless match resolves");
  equal(match?.track.source, "addon", "the match is an addon track");
  equal(match?.stream.lossless, true, "the accepted stream is lossless");
  equal(match?.stream.sampleRateHz, 44100, "stream metadata is carried");
  equal(created[0].searchQualities[0], "lossless", "substitution searches the lossless tier");
  equal(
    created[0].searchQueries[0],
    "gehra hua arijit singh",
    "the first query is title without packaging plus primary artist",
  );
}

{
  const sourceId = SOURCE_A;
  const { service, rows } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://slow-cache.example/secret" }],
    script: () => ({
      searchResult: [matchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac" }),
    }),
  });
  const remember = rows.rememberMany.bind(rows);
  rows.rememberMany = async (refs, fingerprint) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return remember(refs, fingerprint);
  };

  const match = await service.findLosslessMatch(youtubeTarget, { budgetMs: 30 });
  check(match !== null, "a slow row cache does not consume the substitution budget");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://slow-probe.example/secret" }],
    probeLength: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { contentLength: 1234, acceptsRanges: true, sampleRateHz: 44100 };
    },
    script: () => ({
      searchResult: [matchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac" }),
    }),
  });

  const match = await service.findLosslessMatch(youtubeTarget, { budgetMs: 30 });
  check(match !== null, "a slow FLAC probe does not consume the substitution budget");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://late-stats.example/secret" }],
    probeLength: async () => ({
      contentLength: 1_000_000,
      acceptsRanges: true,
      sampleRateHz: 44100,
      bitDepth: 16,
    }),
    script: () => ({
      searchResult: [matchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.flac", format: "flac" }),
    }),
  });

  const match = await service.findLosslessMatch(youtubeTarget);
  const stats = await match?.stream.stats;
  equal(stats?.sampleRateHz, 44100, "late stats carry the sample rate");
  equal(stats?.bitDepth, 16, "late stats carry the bit depth");
  check(stats?.kbps !== undefined, "late stats derive the bitrate");
}

{
  const sourceId = SOURCE_A;
  const { service, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://lossy.example/secret" }],
    script: () => ({ searchResult: [matchRow({ format: "mp3" })] }),
  });

  equal(await service.findLosslessMatch(youtubeTarget), null, "a lossy row is not a lossless match");
  equal(created[0].streamCalls, 0, "no stream is resolved for a lossy row");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://liar.example/secret" }],
    script: () => ({
      searchResult: [matchRow()],
      streamAnswer: () => ({ url: "https://cdn.example/a.mp3", format: "mp3" }),
    }),
  });

  equal(
    await service.findLosslessMatch(youtubeTarget),
    null,
    "a FLAC row that resolves to MP3 is a miss",
  );
}

{
  const sourceId = SOURCE_A;
  const slow = new FakeClient(sourceId, {});
  slow.search = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return [matchRow()];
  };
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://slow.example/secret" }],
    clientFactory: () => slow,
  });

  const startedAt = Date.now();
  equal(
    await service.findLosslessMatch(youtubeTarget, { budgetMs: 20 }),
    null,
    "a slow addon yields no match",
  );
  check(Date.now() - startedAt < 500, "the budget bounds the wait");
}

{
  const sourceId = SOURCE_A;
  const { service, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://query.example/secret" }],
    script: () => ({}),
  });
  created[0].search = async (query, quality) => {
    created[0].searchQueries.push(query);
    created[0].searchQualities.push(quality);
    return query === "gehra hua arijit singh" ? [] : [matchRow()];
  };
  created[0].resolveStream = async () => ({ url: "https://cdn.example/a.flac", format: "flac" });

  const match = await service.findLosslessMatch(youtubeTarget);
  check(match !== null, "the second query finds the match");
  equal(created[0].searchQueries.length, 2, "queries run in order");
  equal(created[0].searchQueries[1], "gehra hua", "the second query drops the artist");
}

{
  const sourceId = SOURCE_A;
  const { service, created } = await setup({
    sources: [{
      id: sourceId,
      baseUrl: "https://gated-substitution.example/secret",
      checkValidLossless: true,
    }],
    outputCapable: false,
  });

  equal(await service.findLosslessMatch(youtubeTarget), null, "a gated source yields no match");
  equal(created.length, 0, "a gated source is never contacted");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://candidates.example/secret" }],
    script: () => ({
      manifest: manifest(),
      searchResult: [matchRow({ id: "first" }), matchRow({ id: "second" })],
      streamError: (trackId) =>
        trackId === "first" ? new AddonRequestError("miss", 404) : undefined,
      streamAnswer: () => ({ url: "https://cdn.example/second.flac", format: "flac" }),
    }),
  });

  const match = await service.findLosslessMatch(youtubeTarget);
  equal(match?.track.addon?.trackId, "second", "a failed candidate falls through to the next");
}

{
  const sourceId = SOURCE_A;
  const { service, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://skip.example/secret" }],
    script: () => ({
      searchResult: [matchRow()],
      streamError: () => new AddonRequestError("server", 503),
    }),
  });

  equal(await service.findLosslessMatch(youtubeTarget), null, "the server error is a miss");
  equal(created[0].searchQueries.length, 1, "a source that errored is not searched again");
}

{
  const sourceId = SOURCE_A;
  const { service, rows } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://storage.example/secret" }],
    script: () => ({ searchResult: [matchRow()] }),
  });
  rows.rememberMany = async () => {
    throw new Error("storage down");
  };

  equal(await service.findLosslessMatch(youtubeTarget), null, "a row-cache failure is a miss");
}

{
  const sourceId = SOURCE_A;
  let clock = 1_000_000;
  const { service, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://cool.example/secret" }],
    now: () => clock,
    script: () => ({ searchError: new AddonRequestError("rejected", 403) }),
  });

  equal(await service.findLosslessMatch(youtubeTarget), null, "a rejected search is a miss");
  equal(created[0].searchCalls, 1, "the rejected source was tried once");

  clock += 60_000;
  equal(await service.findLosslessMatch(youtubeTarget), null, "a miss during cooldown");
  equal(created[0].searchCalls, 1, "a rejected source is skipped during the cooldown");

  clock += 10 * 60_000;
  equal(await service.findLosslessMatch(youtubeTarget), null, "a miss after the cooldown");
  equal(created[0].searchCalls, 2, "a rejected source is retried after the cooldown");
}

{
  const sourceId = SOURCE_A;
  let clock = 1_000_000;
  const script: Script = { searchError: new AddonRequestError("rejected", 403) };
  const { service, created } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://probe-clears.example/secret" }],
    now: () => clock,
    script: () => script,
  });

  equal(await service.findLosslessMatch(youtubeTarget), null, "a rejected search is a miss");
  equal(created[0].searchCalls, 1, "the rejected source was searched once");

  script.searchError = undefined;
  script.searchResult = [matchRow()];
  script.streamAnswer = () => ({ url: "https://cdn.example/a.flac", format: "flac" });
  equal(await service.probeSource(sourceId), "ok", "a recovered probe reports ok");

  clock += 1_000;
  const match = await service.findLosslessMatch(youtubeTarget);
  check(match !== null, "a healthy probe clears the cooldown in the same clock window");
  equal(created[0].searchCalls, 3, "the probe and the match both contact the source again");
}

{
  const sourceId = SOURCE_A;
  const { service } = await setup({
    sources: [{ id: sourceId, baseUrl: "https://row-url.example/secret" }],
    script: () => ({
      searchResult: [matchRow({ id: "direct", streamUrl: "https://cdn.example/direct.flac" })],
      streamError: () => new AddonRequestError("miss", 404),
    }),
  });

  const match = await service.findLosslessMatch(youtubeTarget);
  equal(
    match?.track.addon?.trackId,
    "direct",
    "a /stream miss falls back to the URL the search row supplied",
  );
}

console.log("addon/service: ok");
