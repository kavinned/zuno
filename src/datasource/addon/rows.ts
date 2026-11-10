import { invoke } from "@tauri-apps/api/core";
import { getCachedJson, setCachedJson } from "../../internal/cache";
import type { Track } from "../types";
import type { AddonTrackRef } from "./types";
import { addonCompositeId } from "./url";

export interface CachedAddonRow extends AddonTrackRef {
  sourceFingerprint: string;
  cachedAt: number;
}

export interface AddonRowStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<boolean>;
  remove(key: string): Promise<void>;
}

const ROW_PREFIX = "addon-row:v1:";
const INDEX_PREFIX = "addon-row-index:v1:";

function rowKey(trackId: string): string {
  return `${ROW_PREFIX}${trackId}`;
}

function indexKey(sourceId: string): string {
  return `${INDEX_PREFIX}${sourceId}`;
}

const defaultAddonRowStore: AddonRowStore = {
  get: <T>(key: string) => getCachedJson<T>(key),
  set: <T>(key: string, value: T) => setCachedJson<T>(key, value),
  remove: async (key: string): Promise<void> => {
    await invoke("cache_remove", { key });
  },
};

function isCachedAddonRow(value: unknown): value is CachedAddonRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.sourceId === "string"
    && typeof row.trackId === "string"
    && typeof row.title === "string"
    && typeof row.artist === "string"
    && typeof row.sourceFingerprint === "string"
    && typeof row.cachedAt === "number";
}

export function addonTrackFromRef(ref: AddonTrackRef): Promise<Track> {
  return addonCompositeId(ref.sourceId, ref.trackId).then((id) => ({
    id,
    source: "addon" as const,
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    durationSec: ref.durationSec,
    artworkUrl: ref.artworkUrl,
    addon: ref,
  }));
}

export class AddonRowCache {
  private readonly store: AddonRowStore;

  constructor(store: AddonRowStore = defaultAddonRowStore) {
    this.store = store;
  }

  async rememberMany(refs: AddonTrackRef[], fingerprint: string): Promise<Track[]> {
    const tracks: Track[] = [];
    const idsBySource = new Map<string, string[]>();

    for (const ref of refs) {
      const id = await addonCompositeId(ref.sourceId, ref.trackId);
      const row: CachedAddonRow = { ...ref, sourceFingerprint: fingerprint, cachedAt: Date.now() };
      await this.store.set(rowKey(id), row);
      const ids = idsBySource.get(ref.sourceId);
      if (ids) ids.push(id);
      else idsBySource.set(ref.sourceId, [id]);
      tracks.push(await addonTrackFromRef(row));
    }

    for (const [sourceId, ids] of idsBySource) {
      const key = indexKey(sourceId);
      const existing = await this.store.get<string[]>(key);
      const merged = Array.isArray(existing)
        ? existing.filter((id): id is string => typeof id === "string")
        : [];
      for (const id of ids) {
        if (!merged.includes(id)) merged.push(id);
      }
      await this.store.set(key, merged);
    }

    return tracks;
  }

  async remember(ref: AddonTrackRef, fingerprint: string): Promise<Track> {
    const [track] = await this.rememberMany([ref], fingerprint);
    return track;
  }

  async read(trackId: string): Promise<CachedAddonRow | null> {
    const value = await this.store.get<unknown>(rowKey(trackId));
    return isCachedAddonRow(value) ? value : null;
  }

  async forgetSource(sourceId: string, isProtected?: (trackId: string) => boolean): Promise<void> {
    const key = indexKey(sourceId);
    const stored = await this.store.get<unknown>(key);
    const ids = Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : [];
    const kept: string[] = [];

    for (const id of ids) {
      if (isProtected?.(id)) kept.push(id);
      else await this.store.remove(rowKey(id));
    }

    if (kept.length > 0) await this.store.set(key, kept);
    else await this.store.remove(key);
  }

  toTrack(row: CachedAddonRow): Promise<Track> {
    return addonTrackFromRef(row);
  }
}
