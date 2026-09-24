import { useSyncExternalStore } from "react";
import type { Playlist, Track } from "../datasource/types";
import { getLocalPlaylist, getLocalTracksForPlaylist, isLocalPlaylist } from "./localPlaylists";

const STORAGE_KEY = "ytc-playlist-membership-v1";
export const PLAYLIST_MEMBERSHIP_CHANGE_EVENT = "ytc-playlist-membership-change";

/**
 * Bound on remembered tracks. Entries are tiny (an id and a handful of playlist ids), and
 * the list is pruned oldest-first, so this is only here to stop the key growing without end.
 */
const MAX_REMEMBERED_TRACKS = 1000;

/** trackId -> playlist ids we have seen the track in. Insertion-ordered, oldest first. */
type MembershipRecord = Record<string, string[]>;

let cachedRaw: string | null = null;
let cached: MembershipRecord = {};
let membershipVersion = 0;

function read(): MembershipRecord {
  if (typeof window === "undefined") return {};
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cached;

  cachedRaw = raw;
  cached = {};
  if (!raw) return cached;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [trackId, playlistIds] of Object.entries(parsed)) {
        if (!Array.isArray(playlistIds)) continue;
        cached[trackId] = playlistIds.filter((id): id is string => typeof id === "string");
      }
    }
  } catch {
    // A corrupt key is not worth failing over — treat it as empty and let the next write fix it.
  }
  return cached;
}

function write(next: MembershipRecord): void {
  if (typeof window === "undefined") return;
  const trackIds = Object.keys(next);
  const pruned = trackIds.length > MAX_REMEMBERED_TRACKS
    ? Object.fromEntries(
        trackIds.slice(trackIds.length - MAX_REMEMBERED_TRACKS).map((id) => [id, next[id]]),
      )
    : next;

  cachedRaw = JSON.stringify(pruned);
  cached = pruned;
  membershipVersion += 1;
  localStorage.setItem(STORAGE_KEY, cachedRaw);
  if (typeof window.dispatchEvent === "function") {
    window.dispatchEvent(new Event(PLAYLIST_MEMBERSHIP_CHANGE_EVENT));
  }
}

export function subscribeToPlaylistMembership(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(PLAYLIST_MEMBERSHIP_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(PLAYLIST_MEMBERSHIP_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getPlaylistMembershipVersion(): number {
  return membershipVersion;
}

export function usePlaylistMembershipVersion(): number {
  return useSyncExternalStore(subscribeToPlaylistMembership, getPlaylistMembershipVersion, () => 0);
}

export function barePlaylistId(playlistId: string): string {
  return playlistId.replace(/^VL/, "");
}

/**
 * True when this song is known to already be in this playlist.
 *
 * "Known" is doing real work here. Local playlists and local songs are stored on this machine,
 * so their membership is exact. A YouTube playlist's contents, though, are only knowable by
 * fetching every one of them — far too expensive to do just to draw a tick in a menu. So for
 * those we remember what we have been told: every add reports back "added" or "already-present",
 * and both answers prove membership. The indicator is therefore a "yes" you can trust and a
 * "no" that only means "not as far as we know" — which is why adding an already-added song is
 * still allowed, and still reports "Already in playlist".
 */
export function isTrackKnownInPlaylist(track: Track, playlist: Playlist): boolean {
  if (isLocalPlaylist(playlist)) {
    if (!track.localPath) return false;
    const paths = playlist.localPaths ?? getLocalPlaylist(playlist.id)?.paths ?? [];
    return paths.includes(track.localPath);
  }
  if (track.source === "local") {
    return getLocalTracksForPlaylist(playlist).some((item) => item.localPath === track.localPath);
  }
  const targetBare = barePlaylistId(playlist.id);
  return read()[track.id]?.some((id) => barePlaylistId(id) === targetBare) ?? false;
}

/** Records a confirmed add. Local membership is derived from storage, so it is skipped. */
export function rememberTrackInPlaylist(track: Track, playlist: Playlist): void {
  if (track.source === "local" || isLocalPlaylist(playlist)) return;

  const current = read();
  const existing = current[track.id] ?? [];
  const targetBare = barePlaylistId(playlist.id);
  if (existing.some((id) => barePlaylistId(id) === targetBare)) return;

  // Re-inserting the key moves it to the end, which is what keeps pruning oldest-first.
  const { [track.id]: _dropped, ...rest } = current;
  write({ ...rest, [track.id]: [...existing, playlist.id] });
}

/** Records multiple confirmed playlist memberships at once for a track. */
export function rememberTrackInPlaylists(track: Track, playlistIds: string[]): void {
  if (track.source === "local" || playlistIds.length === 0) return;

  const current = read();
  const existing = current[track.id] ?? [];
  const bareExisting = new Set(existing.map(barePlaylistId));
  const toAdd: string[] = [];
  for (const id of playlistIds) {
    const bare = barePlaylistId(id);
    if (!bareExisting.has(bare)) {
      bareExisting.add(bare);
      toAdd.push(id);
    }
  }
  if (toAdd.length === 0) return;

  const { [track.id]: _dropped, ...rest } = current;
  write({ ...rest, [track.id]: [...existing, ...toAdd] });
}

/** Forgets a membership so removing a song from a playlist clears its tick. */
export function forgetTrackInPlaylist(track: Track, playlist: Playlist): void {
  const current = read();
  const existing = current[track.id];
  const targetBare = barePlaylistId(playlist.id);
  if (!existing?.some((id) => barePlaylistId(id) === targetBare)) return;

  write({
    ...current,
    [track.id]: existing.filter((id) => barePlaylistId(id) !== targetBare),
  });
}
