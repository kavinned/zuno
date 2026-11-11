/** The one track being resolved and preloaded ahead of playback. */
export interface WarmSlot {
  trackId: string;
  /** Resolves after the preload attempt; callers must never expect a rejection. */
  promise: Promise<void>;
}

/**
 * How long a click waits for the warm before falling back to the ordinary load.
 *
 * Kept under the 2500 ms substitution budget so a join normally settles before the caller
 * starts a duplicate resolve; a timeout is handled as an abandoned warm, not a lost one.
 */
export const WARM_JOIN_MS = 2000;

/** Whether the warm slot is preparing `trackId`. */
export function isWarmingTrack(slot: WarmSlot | null, trackId: string): slot is WarmSlot {
  return slot?.trackId === trackId;
}

/**
 * Whether playback must tear the engine down before loading `targetId`.
 *
 * A cued standby, or a warm still being prepared for this very track, is handed over rather
 * than discarded.
 */
export function shouldTearDownBeforePlay(
  preloaded: boolean,
  warmingTrackId: string | null,
  targetId: string,
): boolean {
  return !preloaded && warmingTrackId !== targetId;
}

/**
 * Waits for the warm to settle, but only for a track it belongs to.
 *
 * Resolves false when the slot is for another track or the wait expired, so the caller keeps
 * the ordinary load path. The slot's promise never rejects by construction.
 */
export async function joinWarm(
  slot: WarmSlot | null,
  trackId: string,
  waitMs = WARM_JOIN_MS,
): Promise<boolean> {
  if (!isWarmingTrack(slot, trackId)) return false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  try {
    return await Promise.race([slot.promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
