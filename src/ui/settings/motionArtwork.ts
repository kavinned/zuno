import { useSyncExternalStore } from "react";

/**
 * Whether the lyrics screen may show Apple Music's animated album artwork.
 *
 * On by default: the feature is invisible unless a track actually has motion artwork, and the
 * setting exists so anyone who does not want the extra lookups can turn it off.
 */
const STORAGE_KEY = "motion-artwork";
const CHANGE_EVENT = "motion-artwork-change";

export const DEFAULT_MOTION_ARTWORK = true;

export function getMotionArtworkEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_MOTION_ARTWORK : raw === "true";
  } catch {
    return DEFAULT_MOTION_ARTWORK;
  }
}

export function setMotionArtworkEnabled(enabled: boolean): void {
  try {
    if (enabled === DEFAULT_MOTION_ARTWORK) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Quota or a locked profile: the choice still applies for this session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  // Not optional in a multi-window app: without it the other window never sees the change.
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useMotionArtworkEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    getMotionArtworkEnabled,
    () => DEFAULT_MOTION_ARTWORK,
  );
}
