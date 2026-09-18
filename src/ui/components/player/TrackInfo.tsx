import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SpinnerSteps } from "@/components/motion/loader";
import { Marquee } from "@/components/motion/marquee";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  HeartActiveIcon,
  HeartBrokenIcon,
  HeartIcon,
  PlaylistAddIcon,
  PlaylistIcon,
  SearchIcon,
} from "@/ui/icons";
import { shallowEqual, usePlayerSelector } from "../../../player/playerStore";
import { useLibraryState } from "../../../player/playerStore";
import { usePlayerUIState } from "../../stores/playerUIStore";
import { TrackArtwork } from "../TrackArtwork";
import { ArtistLinks } from "../ArtistLinks";
import { useTrackContextMenu } from "../TrackContextMenu";
import { FloatingPanel } from "../FloatingPanel";
import {
  setDefaultPlaylist,
  useDefaultPlaylist,
} from "../../settings/defaultPlaylist";
import {
  getLocalPlaylistItems,
  isLocalPlaylist,
  subscribeToLocalPlaylists,
} from "../../../player/localPlaylists";
import type { Playlist } from "../../../datasource/types";

const NO_LOCAL_PLAYLISTS: Playlist[] = [];
const getNoLocalPlaylists = () => NO_LOCAL_PLAYLISTS;

function barePlaylistId(playlistId: string): string {
  return playlistId.replace(/^VL/, "");
}

export function TrackInfo() {
  const state = usePlayerSelector((player) => ({ currentTrack: player.currentTrack }), shallowEqual);
  const libraryState = useLibraryState();
  const uiState = usePlayerUIState();
  const { openTrackMenu, openPlaylistPicker, toggleTrackLike, addTrackToPlaylist, showToast } =
    useTrackContextMenu();
  const currentTrack = state.currentTrack;
  const titleViewportRef = useRef<HTMLDivElement>(null);
  const titleTextRef = useRef<HTMLSpanElement>(null);
  const [isTitleOverflowing, setIsTitleOverflowing] = useState(false);

  const defaultPlaylist = useDefaultPlaylist();
  const [isDefaultMenuOpen, setIsDefaultMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isAddingToPlaylist, setIsAddingToPlaylist] = useState(false);

  const localPlaylists = useSyncExternalStore(
    subscribeToLocalPlaylists,
    getLocalPlaylistItems,
    getNoLocalPlaylists,
  );

  const playlists = useMemo(() => {
    const seen = new Set<string>();
    const candidates: Playlist[] = [];
    for (const playlist of [...(libraryState.library?.playlists ?? []), ...localPlaylists]) {
      if (seen.has(playlist.id)) continue;
      seen.add(playlist.id);
      candidates.push(playlist);
    }
    return candidates;
  }, [libraryState.library?.playlists, localPlaylists]);

  const filteredPlaylists = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return playlists;
    return playlists.filter((p) => p.title.toLowerCase().includes(q));
  }, [playlists, searchQuery]);

  // Only scroll a title that actually overflows — a permanent marquee on short
  // titles is noise. Measured rather than guessed from character count.
  useLayoutEffect(() => {
    const viewport = titleViewportRef.current;
    const text = titleTextRef.current;
    if (!viewport || !text) return;

    const updateOverflow = () => {
      setIsTitleOverflowing(text.scrollWidth - viewport.clientWidth > 1);
    };
    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [currentTrack?.title]);

  if (!currentTrack) {
    return null;
  }

  const isLikeStatusLoading =
    (libraryState.status === "restoring" || libraryState.status === "loading")
    && !libraryState.library;
  const canLikeCurrentTrack = currentTrack.source !== "local";
  const isLikePending = canLikeCurrentTrack && libraryState.pendingLikeTrackIds.has(currentTrack.id);
  const isLiked = canLikeCurrentTrack && (libraryState.library?.likedSongs.some(
    (track) => track.id === currentTrack.id,
  ) ?? false);

  const handleAddToPlaylistClick = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (isAddingToPlaylist || !currentTrack) return;

    if (!defaultPlaylist) {
      openPlaylistPicker(currentTrack);
      return;
    }

    const target = playlists.find(
      (p) =>
        p.id === defaultPlaylist.id
        || barePlaylistId(p.id) === barePlaylistId(defaultPlaylist.id),
    ) ?? {
      id: defaultPlaylist.id,
      title: defaultPlaylist.title,
      owner: "",
      kind: defaultPlaylist.id.startsWith("local-playlist:") ? "local" : "playlist",
    };

    if (isLocalPlaylist(target) && currentTrack.source !== "local") {
      showToast("Online songs cannot be added to local playlists.");
      return;
    }

    setIsAddingToPlaylist(true);
    try {
      await addTrackToPlaylist(currentTrack, target);
    } finally {
      setIsAddingToPlaylist(false);
    }
  };

  const handleButtonContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDefaultMenuOpen((open) => !open);
  };

  const playlistButtonTitle = defaultPlaylist
    ? `Add to ${defaultPlaylist.title}\n(Right-click to change default)`
    : "Add to playlist\n(Right-click to set default)";

  return (
    <div
      className="flex min-w-0 items-center gap-3"
      onContextMenu={(event) => openTrackMenu(event, currentTrack)}
    >
      {uiState.showAlbumArt && (
        <TrackArtwork
          className="size-12 shrink-0 object-cover"
          size={48}
          artworkUrl={currentTrack.artworkUrl}
          iconSize={22}
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div ref={titleViewportRef} className="relative min-w-0 overflow-hidden">
          {/* Hidden measuring copy — Marquee duplicates its children, so width
              must be read from a single stable node. */}
          <span
            ref={titleTextRef}
            aria-hidden={isTitleOverflowing}
            className={cn(
              "block whitespace-nowrap text-sm font-medium text-foreground",
              isTitleOverflowing && "invisible absolute",
            )}
          >
            {currentTrack.title}
          </span>
          {isTitleOverflowing && (
            <Marquee speed={22} gap="2.5rem" className="text-sm font-medium text-foreground">
              <span className="whitespace-nowrap" title={currentTrack.title}>
                {currentTrack.title}
              </span>
            </Marquee>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <ArtistLinks artists={currentTrack.artists} fallback={currentTrack.artist} />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {canLikeCurrentTrack && (
          <button
            type="button"
            className={cn(
              "group/like flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
              "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isLiked ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => void toggleTrackLike(currentTrack)}
            disabled={isLikeStatusLoading || isLikePending}
            aria-label={
              isLikeStatusLoading || isLikePending
                ? "Loading like status"
                : isLiked
                  ? "Remove like"
                  : libraryState.status === "signed-out"
                    ? "Sign in to like"
                    : "Like song"
            }
            title={
              libraryState.status === "signed-out"
                ? "Sign in to like"
                : isLiked
                  ? "Remove like"
                  : "Like song"
            }
          >
            {isLikeStatusLoading || isLikePending ? (
              <SpinnerSteps size={18} color="currentColor" />
            ) : isLiked ? (
              // Hovering a liked track previews the un-like action.
              <span className="relative grid size-[18px] place-items-center" aria-hidden="true">
                <HeartActiveIcon
                  size={18}
                  className="absolute transition-opacity group-hover/like:opacity-0"
                />
                <HeartBrokenIcon
                  size={18}
                  className="absolute opacity-0 transition-opacity group-hover/like:opacity-100"
                />
              </span>
            ) : (
              <HeartIcon size={18} />
            )}
          </button>
        )}

        <FloatingPanel
          open={isDefaultMenuOpen}
          onOpenChange={setIsDefaultMenuOpen}
          side="top"
          triggerClassName="shrink-0"
          className="flex max-h-80 w-64 flex-col gap-2 p-2"
          trigger={
            <button
              type="button"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
                "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "text-muted-foreground hover:text-foreground",
              )}
              onClick={(e) => void handleAddToPlaylistClick(e)}
              onContextMenu={handleButtonContextMenu}
              disabled={isAddingToPlaylist}
              aria-label={
                defaultPlaylist ? `Add to ${defaultPlaylist.title}` : "Add to playlist"
              }
              title={playlistButtonTitle}
            >
              {isAddingToPlaylist ? (
                <SpinnerSteps size={18} color="currentColor" />
              ) : (
                <PlaylistAddIcon size={18} />
              )}
            </button>
          }
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between px-1.5 pt-0.5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Default Playlist
              </span>
            </div>
            {playlists.length > 5 && (
              <div className="relative flex items-center px-1">
                <SearchIcon size={13} className="pointer-events-none absolute left-3 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search playlists..."
                  className="w-full rounded-md bg-muted/60 py-1 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}
            <div className="flex max-h-52 flex-col gap-0.5 overflow-y-auto overflow-x-hidden pr-0.5">
              <button
                type="button"
                onClick={() => {
                  setDefaultPlaylist(null);
                  showToast("Default playlist cleared");
                  setIsDefaultMenuOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-card",
                  !defaultPlaylist && "font-medium text-primary",
                )}
              >
                <span className="truncate">None (ask every time)</span>
                {!defaultPlaylist && <CheckIcon size={13} className="shrink-0" />}
              </button>

              {filteredPlaylists.map((playlist) => {
                const isSelected =
                  defaultPlaylist?.id === playlist.id
                  || barePlaylistId(defaultPlaylist?.id ?? "") === barePlaylistId(playlist.id);
                return (
                  <button
                    key={playlist.id}
                    type="button"
                    onClick={() => {
                      setDefaultPlaylist({ id: playlist.id, title: playlist.title });
                      showToast(`Default playlist set to "${playlist.title}"`);
                      setIsDefaultMenuOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-card",
                      isSelected && "font-medium text-primary",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <PlaylistIcon size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{playlist.title}</span>
                    </div>
                    {isSelected && <CheckIcon size={13} className="shrink-0" />}
                  </button>
                );
              })}

              {filteredPlaylists.length === 0 && playlists.length > 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No matching playlists
                </div>
              )}
              {playlists.length === 0 && (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                  No playlists found
                </div>
              )}
            </div>
          </div>
        </FloatingPanel>
      </div>
    </div>
  );
}

