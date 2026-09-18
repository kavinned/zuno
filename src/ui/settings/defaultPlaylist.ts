import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { setAppSetting } from "../../internal/appSettings";

export interface DefaultPlaylistSetting {
  id: string;
  title: string;
}

const STORAGE_KEY = "player-default-playlist";
const CHANGE_EVENT = "default-playlist-change";

function isValidDefaultPlaylist(value: unknown): value is DefaultPlaylistSetting {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DefaultPlaylistSetting).id === "string" &&
    typeof (value as DefaultPlaylistSetting).title === "string"
  );
}

let cached: DefaultPlaylistSetting | null | undefined = undefined;

export function getDefaultPlaylist(): DefaultPlaylistSetting | null {
  if (cached === undefined) {
    cached = readLocalJsonSetting<DefaultPlaylistSetting>(STORAGE_KEY, isValidDefaultPlaylist);
  }
  return cached;
}

export function setDefaultPlaylist(playlist: DefaultPlaylistSetting | null): void {
  cached = playlist;
  if (playlist === null) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Storage access blocked or unavailable
    }
    void setAppSetting(STORAGE_KEY, null);
  } else {
    writeLocalJsonSetting(STORAGE_KEY, playlist);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    cached = undefined;
  });
}

export function useDefaultPlaylist(): DefaultPlaylistSetting | null {
  return useSyncExternalStore(subscribe, getDefaultPlaylist, () => null);
}

export async function hydrateDefaultPlaylist(): Promise<void> {
  await hydrateLocalJsonSetting(STORAGE_KEY, isValidDefaultPlaylist);
  cached = undefined;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
