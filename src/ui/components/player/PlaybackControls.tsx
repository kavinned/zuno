import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  PauseActiveIcon,
  PlayActiveIcon,
  RepeatActiveIcon,
  RepeatIcon,
  RepeatOneActiveIcon,
  ShuffleActiveIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPreviousIcon,
} from "@/ui/icons";
import { shallowEqual, usePlayerSelector } from "../../../player/playerStore";
import { playerController } from "../../../player/playerStore";

interface PlaybackControlsProps {
  extraControlsAlwaysVisible?: boolean;
}

const CONTROL_BUTTON =
  "flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Crossfade+scale used by the play/pause/loading glyph swap. */
const GLYPH_MOTION = {
  initial: { opacity: 0, scale: 0.6 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.6 },
  transition: { type: "spring" as const, stiffness: 620, damping: 34 },
};

export function PlaybackControls({ extraControlsAlwaysVisible = true }: PlaybackControlsProps) {
  const state = usePlayerSelector(
    (player) => ({
      currentTrack: player.currentTrack,
      status: player.status,
      playbackOrderMode: player.playbackOrderMode,
      shuffleEnabled: player.shuffleEnabled,
    }),
    shallowEqual,
  );
  const isBusy = state.status === "loading";
  const isPlaying = state.status === "playing";
  const hasCurrentTrack = Boolean(state.currentTrack);

  const handlePlayPause = () => {
    void playerController.togglePlayPause();
  };

  const handleSkipNext = () => {
    void playerController.skipToNext();
  };

  const handleSkipPrevious = () => {
    void playerController.skipToPrevious();
  };

  const handlePlaybackOrderCycle = () => {
    playerController.cyclePlaybackOrderMode();
  };

  const handleShuffleToggle = () => {
    playerController.toggleShuffle();
  };

  const orderLabel =
    state.playbackOrderMode === "repeat-one"
      ? "Loop current song"
      : state.playbackOrderMode === "repeat-all"
        ? "Loop the queue"
        : "Play in order";

  // In-order is the resting state, so it reads as Linear; the other two are Bold.
  const isOrderActive = state.playbackOrderMode !== "in-order";
  const isShuffled = state.shuffleEnabled;

  return (
    <div className="flex items-center gap-1">
      {/*
        Shuffle sits opposite repeat, the arrangement every player shares — and it is what the
        spacer here used to stand in for, so the previous/play/next trio stays centred without
        a placeholder. Both fade together when the extra controls are set to appear on hover.
      */}
      <div
        className={cn(
          "size-9 shrink-0 transition-opacity",
          !extraControlsAlwaysVisible &&
            "opacity-0 focus-within:opacity-100 group-hover/playerbar:opacity-100",
        )}
      >
        <button
          type="button"
          className={cn(CONTROL_BUTTON, isShuffled && "text-primary hover:text-primary")}
          onClick={handleShuffleToggle}
          aria-pressed={isShuffled}
          aria-label={isShuffled ? "Turn off shuffle" : "Shuffle"}
          title={isShuffled ? "Shuffle is on" : "Shuffle"}
        >
          {isShuffled ? <ShuffleActiveIcon size={20} /> : <ShuffleIcon size={20} />}
        </button>
      </div>

      <button
        type="button"
        className={CONTROL_BUTTON}
        onClick={handleSkipPrevious}
        disabled={!hasCurrentTrack}
        aria-label="Previous track"
      >
        <SkipPreviousIcon size={20} />
      </button>

      <button
        type="button"
        className={cn(
          "flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[transform,background-color] hover:bg-primary/80 active:scale-95 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          !hasCurrentTrack && "opacity-40",
        )}
        onClick={handlePlayPause}
        disabled={isBusy || !hasCurrentTrack}
        aria-label={isBusy ? "Loading song" : isPlaying ? "Pause" : "Play"}
      >
        <span className="relative flex size-6 items-center justify-center" aria-hidden="true">
          <AnimatePresence initial={false} mode="popLayout">
            {isBusy ? (
              <motion.span
                key="loading"
                {...GLYPH_MOTION}
                className="absolute inset-0 flex items-center justify-center"
              >
                <svg
                  className="size-6 animate-spin text-white"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    className="opacity-30"
                    cx="12"
                    cy="12"
                    r="9.5"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  />
                  <path
                    className="opacity-100"
                    fill="currentColor"
                    d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5h-2.5A7 7 0 0 0 12 5z"
                  />
                </svg>
              </motion.span>
            ) : isPlaying ? (
              <motion.span
                key="pause"
                {...GLYPH_MOTION}
                className="absolute inset-0 flex items-center justify-center"
              >
                <PauseActiveIcon size={22} className="text-white" />
              </motion.span>
            ) : (
              <motion.span
                key="play"
                {...GLYPH_MOTION}
                className="absolute inset-0 flex items-center justify-center translate-x-0.5"
              >
                <PlayActiveIcon size={22} className="text-white" />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      </button>

      <button
        type="button"
        className={CONTROL_BUTTON}
        onClick={handleSkipNext}
        disabled={!hasCurrentTrack}
        aria-label="Next track"
      >
        <SkipNextIcon size={20} />
      </button>

      <div
        className={cn(
          "size-9 shrink-0 transition-opacity",
          !extraControlsAlwaysVisible &&
            "opacity-0 focus-within:opacity-100 group-hover/playerbar:opacity-100",
        )}
      >
        <button
          type="button"
          className={cn(CONTROL_BUTTON, isOrderActive && "text-primary hover:text-primary")}
          onClick={handlePlaybackOrderCycle}
          aria-label={orderLabel}
          title={orderLabel}
        >
          {state.playbackOrderMode === "repeat-one" ? (
            <RepeatOneActiveIcon size={20} />
          ) : state.playbackOrderMode === "repeat-all" ? (
            <RepeatActiveIcon size={20} />
          ) : (
            <RepeatIcon size={20} />
          )}
        </button>
      </div>
    </div>
  );
}
