import { parseTrackTitle } from "../addon/title";
import {
  sharesNonLatinGlyphs,
  splitNames,
  titleCoreMatches,
  versionMarkersFor,
} from "../addon/matcher";

/** One row from `GET https://lrc.red/search.json?q=…`. */
export interface LrcRedHit {
  isrc: string;
  title: string;
  artist: string;
  album?: string;
  duration: number;
  /** lrc.red marks entries whose timings were produced by a model. */
  byModel?: boolean;
}

/** The track fields the hit selector needs; `Track` satisfies this structurally. */
export interface LrcRedTarget {
  title: string;
  artist: string;
  artists?: Array<{ name: string }>;
  album?: string;
  durationSec?: number;
}

export interface LrcRedSearchResponse {
  hits?: LrcRedHit[];
}

/** The same tolerance the loose LRCLIB search uses. */
const MAX_DURATION_DELTA_SEC = 2;

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

/**
 * The one search hit worth asking for TTML, or undefined.
 *
 * lrc.red search returns covers and live takes beside the real recording. The duration gate
 * and the version markers are what keep this screen following the song that is actually
 * playing; the artist check keeps a same-length cover from stealing the lookup.
 */
export function pickLrcRedHit(
  target: LrcRedTarget,
  hits: LrcRedHit[],
): LrcRedHit | undefined {
  const durationSec = target.durationSec;
  if (!durationSec || durationSec <= 0) return undefined;

  const targetParts = parseTrackTitle(target.title);
  const targetNames = [
    target.artist,
    ...(target.artists?.map((artist) => artist.name) ?? []),
  ].flatMap((name) => splitNames(name));
  const targetMarkers = versionMarkersFor(targetParts, target.album);

  const candidates = hits.filter((hit) => {
    if (
      !Number.isFinite(hit.duration) ||
      Math.abs(hit.duration - durationSec) > MAX_DURATION_DELTA_SEC
    ) {
      return false;
    }

    const hitParts = parseTrackTitle(hit.title);
    if (!titleCoreMatches(targetParts, hitParts)) return false;
    if (!sameSet(targetMarkers, versionMarkersFor(hitParts, hit.album))) return false;

    const hitNames = splitNames(hit.artist);
    if (hitNames.some((name) => targetNames.includes(name))) return true;
    return targetNames.some((name) =>
      hitNames.some((hitName) => sharesNonLatinGlyphs(name, hitName)),
    );
  });

  // Stable sort keeps lrc.red's relevance order among entries made the same way.
  return [...candidates].sort(
    (left, right) => Number(Boolean(left.byModel)) - Number(Boolean(right.byModel)),
  )[0];
}
