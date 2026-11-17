import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "./durableLocalSetting";

const STORAGE_KEY = "zuno.lossless-opt-outs.v1";
const CHANGE_EVENT = "lossless-opt-outs-change";

const EMPTY_SNAPSHOT: string[] = [];
const getEmptySnapshot = (): string[] => EMPTY_SNAPSHOT;

/** Both windows must agree on what an empty list is; `useSyncExternalStore` needs one identity. */
function isTrackIdList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isTrackId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

let cached: string[] = EMPTY_SNAPSHOT;
/* `undefined` means "not read yet", which is distinct from a stored `null`. */
let cachedRaw: string | null | undefined;

/**
 * Reads through the raw string, not only the parsed array.
 *
 * The settings screen clears localStorage wholesale, and that fires no event in this window.
 * Comparing the raw value means the next check sees the clear without a restart, while the
 * cached array keeps `useSyncExternalStore` from re-rendering on every call.
 */
function read(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* Storage unavailable: keep whatever this process already knows. A real clear returns
       null above, so this only covers an environment where the API itself is missing. */
    return cached;
  }
  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  const stored = readLocalJsonSetting(STORAGE_KEY, isTrackIdList) ?? [];
  /* Per entry, not all-or-nothing: one corrupt id must not cost every valid preference. */
  cached = [...new Set(stored.filter(isTrackId))];
  return cached;
}

function write(ids: string[]): void {
  writeLocalJsonSetting(STORAGE_KEY, ids);
  cached = ids;
  /*
   * Trust what the store actually holds, not what it was asked to hold. When `setItem` fails
   * (quota, locked profile) the raw value is still the pre-write one; `read()` then sees it
   * equal to `cachedRaw` and hands back this cache, so the click's own reload still respects
   * the choice. A later successful write retries storage and the durable mirror.
   */
  try {
    cachedRaw = localStorage.getItem(STORAGE_KEY);
  } catch {
    cachedRaw = undefined;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function isLosslessOptedOut(trackId: string): boolean {
  return read().includes(trackId);
}

export function setLosslessOptOut(trackId: string, optedOut: boolean): void {
  const ids = read();
  if (optedOut) {
    if (!ids.includes(trackId)) write([...ids, trackId]);
    return;
  }
  if (ids.includes(trackId)) write(ids.filter((id) => id !== trackId));
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    cachedRaw = undefined;
  });
}

export function useLosslessOptedOut(trackId: string): boolean {
  return useSyncExternalStore(subscribe, read, getEmptySnapshot).includes(trackId);
}

export async function hydrateLosslessOptOuts(): Promise<void> {
  await hydrateLocalJsonSetting(STORAGE_KEY, isTrackIdList);
  cachedRaw = undefined;
  cached = EMPTY_SNAPSHOT;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
