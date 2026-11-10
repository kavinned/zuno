import { useSyncExternalStore } from "react";
import type { AddonRegistryState } from "../../datasource/addon/registry";
import type { Track } from "../../datasource/types";
import { addonRegistry, addonService } from "../../player/playerStore";

/*
 * Hoisted for the same reason as the player subscriptions: an inline `subscribe` would be a
 * fresh identity every render and re-subscribe the whole card on each one.
 */
const subscribe = (listener: () => void) => addonRegistry.subscribe(listener);
const getState = () => addonRegistry.getState();

/** The configured addon sources, kept live as probes and edits land. */
export function useAddonSources(): AddonRegistryState {
  return useSyncExternalStore(subscribe, getState, getState);
}

/**
 * Whether the download UI may offer this track.
 *
 * Non-addon tracks are unaffected. An addon track goes through the service so the answer is
 * exactly what `resolveDownloadUrl` will enforce — no source, a manifest that forbids
 * downloads, or a gated source all read as false. Subscribing here is what lets a probe that
 * learns `allowDownloads: false` hide the button without a reload.
 */
export function useAddonDownloadsAllowed(track: Track | null): boolean {
  useAddonSources();
  if (track === null || track.addon === undefined) return true;
  return addonService.allowDownloads(track);
}
