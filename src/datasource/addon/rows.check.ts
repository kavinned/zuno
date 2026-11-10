export {};

import { AddonRowCache, type AddonRowStore, type CachedAddonRow } from "./rows";
import type { AddonTrackRef } from "./types";
import { addonCompositeId } from "./url";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

class FakeStore implements AddonRowStore {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    return this.values.has(key) ? (this.values.get(key) as T) : null;
  }

  async set<T>(key: string, value: T): Promise<boolean> {
    const changed = this.values.get(key) !== value;
    this.values.set(key, value);
    return changed;
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const sourceId = "3f1c2a44-1111-4222-8333-444455556666";
const fingerprint = "fingerprint-one";
const ref: AddonTrackRef = {
  sourceId,
  trackId: "tidal:479222720/../x?y",
  title: "Song Title",
  artist: "Song Artist",
  album: "Song Album",
  durationSec: 201,
  artworkUrl: "https://img.example/a.jpg",
  format: "flac",
};

const store = new FakeStore();
const cache = new AddonRowCache(store);

const track = await cache.remember(ref, fingerprint);
check(track.id.startsWith("addon."), "composite id");
equal(track.id, await addonCompositeId(sourceId, ref.trackId), "composite id is the safe hash");
equal(track.source, "addon", "track source");
equal(track.title, ref.title, "title copied");
equal(track.artist, ref.artist, "artist copied");
equal(track.addon?.trackId, ref.trackId, "addon ref preserved");
equal(track.addon?.format, ref.format, "addon ref format preserved");

const rowKey = `addon-row:v1:${track.id}`;
check(rowKey.startsWith("addon-row:v1:"), "row key prefix");
check(store.values.has(rowKey), "row written under the prefixed key");

const row = await cache.read(track.id);
check(row !== null, "row round-trips");
equal(await store.get(rowKey), row, "row persisted");
equal(row?.sourceFingerprint, fingerprint, "fingerprint stored verbatim");
equal(typeof row?.cachedAt, "number", "cachedAt stored");

const mapped = await cache.toTrack(row as CachedAddonRow);
equal(mapped.id, track.id, "toTrack keeps the composite id");
equal(mapped.source, "addon", "toTrack sets addon source");
equal(mapped.title, ref.title, "toTrack copies title");
equal(mapped.artist, ref.artist, "toTrack copies artist");
equal(mapped.album, ref.album, "toTrack copies album");
equal(mapped.durationSec, ref.durationSec, "toTrack copies duration");
equal(mapped.artworkUrl, ref.artworkUrl, "toTrack copies artwork");

equal(await cache.read("addon.missing"), null, "missing row returns null");
await store.set("addon-row:v1:corrupt", { title: 42 });
equal(await cache.read("corrupt"), null, "malformed row returns null");
await store.set("addon-row:v1:garbage", "not a row");
equal(await cache.read("garbage"), null, "non-object row returns null");

const manyStore = new FakeStore();
const many = new AddonRowCache(manyStore);
const indexKey = `addon-row-index:v1:${sourceId}`;
const refA: AddonTrackRef = { sourceId, trackId: "a", title: "A", artist: "Artist" };
const refB: AddonTrackRef = { sourceId, trackId: "b", title: "B", artist: "Artist" };
const tracks = await many.rememberMany([refA, refB], fingerprint);
equal(tracks.length, 2, "rememberMany returns every track");
equal(tracks[0].title, "A", "rememberMany preserves order");

let index = await manyStore.get<string[]>(indexKey);
equal(index?.length, 2, "index holds both ids");
check(index?.includes(tracks[0].id) === true, "index holds first id");
check(index?.includes(tracks[1].id) === true, "index holds second id");

await many.rememberMany([refA], fingerprint);
index = await manyStore.get<string[]>(indexKey);
equal(index?.length, 2, "index has no duplicates");

const keptId = tracks[0].id;
const goneId = tracks[1].id;
await many.forgetSource(sourceId, (id) => id === keptId);
check((await many.read(keptId)) !== null, "protected row kept");
equal(await many.read(goneId), null, "unprotected row removed");
equal((await manyStore.get<string[]>(indexKey))?.join(","), keptId, "index rewritten to kept ids");

await many.forgetSource(sourceId);
equal(await manyStore.get(indexKey), null, "empty index key removed");
equal(await many.read(keptId), null, "last row removed");

const downloadStore = new FakeStore();
const downloadCache = new AddonRowCache(downloadStore);
const other = await downloadCache.remember({ ...ref, trackId: "other" }, fingerprint);
const downloaded = await downloadCache.remember({ ...ref, trackId: "downloaded" }, fingerprint);
await downloadCache.forgetSource(sourceId, (id) => id === downloaded.id);
check((await downloadCache.read(downloaded.id)) !== null, "downloaded row survives source removal");
equal(await downloadCache.read(other.id), null, "undownloaded row removed");

const fingerprintStore = new FakeStore();
const fingerprintCache = new AddonRowCache(fingerprintStore);
const first = await fingerprintCache.remember({ ...ref, trackId: "first" }, "fingerprint-a");
const second = await fingerprintCache.remember({ ...ref, trackId: "second" }, "fingerprint-b");
equal((await fingerprintCache.read(first.id))?.sourceFingerprint, "fingerprint-a", "first fingerprint kept");
equal((await fingerprintCache.read(second.id))?.sourceFingerprint, "fingerprint-b", "second fingerprint kept");

console.log("addon/rows: ok");
