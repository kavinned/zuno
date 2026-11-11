import type { AddonSearchRow } from "./types";
import { parseTrackTitle, type ParsedTrackTitle } from "./title";

export interface MatchTarget {
  title: string;
  artist: string;
  artists?: Array<{ name: string }>;
  album?: string;
  durationSec?: number;
}

export interface MatchCandidate {
  sourceId: string;
  sourceOrder: number;
  row: AddonSearchRow;
}

export interface RankedCandidate {
  candidate: MatchCandidate;
  score: number;
}

type ArtistEvidence = "exact" | "shared" | "none" | "rejected";
type DurationEvidence = "tight" | "loose" | "none" | "rejected";

const LOSSLESS_CODECS = /\b(?:flac|alac|wav|aiff|pcm)\b/i;
const LOSSLESS_TEXTS = ["lossless", "hi-res", "hires"];
const ARTIST_SPLIT =
  /\s*(?:,|&|\/|;)\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+x\s+|\s+with\s+/i;

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeAlbum(value: string | undefined): string | null {
  const normalized = normalize(value ?? "");
  return normalized.length > 0 ? normalized : null;
}

function splitNames(value: string | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.split(ARTIST_SPLIT).map(normalize).filter(Boolean))];
}

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

/** The side's own markers plus the album's, so a karaoke or instrumental album is a different take. */
function versionMarkersFor(parts: ParsedTrackTitle, album: string | undefined): string[] {
  const markers = [...parts.versionMarkers];
  const normalizedAlbum = normalize(album ?? "");
  if (normalizedAlbum.includes("instrumental")) markers.push("instrumental");
  if (normalizedAlbum.includes("karaoke")) markers.push("karaoke");
  return markers;
}

function hasNonLatinLetter(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length > 0 && !/^\p{Script=Latin}+$/u.test(letters);
}

function titleCoreMatches(target: ParsedTrackTitle, row: ParsedTrackTitle): boolean {
  const targetCore = target.core;
  const rowCore = row.core;
  if (targetCore.length > 0 && targetCore === rowCore) return true;
  if (
    targetCore.length >= 4 &&
    rowCore.length >= 4 &&
    (targetCore.includes(rowCore) || rowCore.includes(targetCore))
  ) {
    return true;
  }
  /*
   * An addon row may carry only the parenthetical (`(New Era)`), leaving its alias as the
   * whole identity. When that row has no separate core, matching the other side's alias is
   * the only bridge; artist and version-marker checks still guard it.
   */
  if (rowCore.length > 0 && rowCore === row.aliases[0] && target.aliases.includes(rowCore)) {
    return true;
  }
  if (targetCore.length > 0 && targetCore === target.aliases[0] && row.aliases.includes(targetCore)) {
    return true;
  }
  return (
    (targetCore.length >= 2 &&
      row.aliases.some(
        (alias) =>
          alias.includes(targetCore) &&
          (hasNonLatinLetter(targetCore) || hasNonLatinLetter(alias)),
      )) ||
    (rowCore.length >= 2 &&
      target.aliases.some(
        (alias) =>
          alias.includes(rowCore) && (hasNonLatinLetter(rowCore) || hasNonLatinLetter(alias)),
      ))
  );
}

function artistEvidence(target: MatchTarget, row: AddonSearchRow): ArtistEvidence {
  const rowNames = splitNames(row.artist);
  const targetNames = [
    ...(target.artists ?? []).map((entry) => normalize(entry.name)).filter(Boolean),
    ...splitNames(target.artist),
  ];
  if (targetNames.length === 0 || rowNames.length === 0) return "none";
  if (normalize(target.artist) === normalize(row.artist ?? "")) return "exact";
  const targetSet = new Set(targetNames);
  if (rowNames.some((name) => targetSet.has(name))) return "shared";
  /*
   * A unit's tracks are often credited to the parent group while the album names the unit
   * ("Red Velvet - IRENE & SEULGI - ..."). The album line is then the only artist evidence.
   */
  const album = normalize(row.album ?? "");
  const targetArtist = normalize(target.artist);
  if (targetArtist.length > 0 && album.includes(targetArtist)) return "shared";
  return "rejected";
}

function durationEvidence(
  targetSec: number | undefined,
  rowSec: number | undefined,
): DurationEvidence {
  if (targetSec === undefined || rowSec === undefined) return "none";
  const diff = Math.abs(targetSec - rowSec);
  if (diff > 30) return "rejected";
  return diff <= 3 ? "tight" : "loose";
}

function albumMatches(target: MatchTarget, row: AddonSearchRow): boolean {
  const targetAlbum = normalizeAlbum(target.album);
  return targetAlbum !== null && targetAlbum === normalizeAlbum(row.album);
}

function sharesContextWord(target: ParsedTrackTitle, row: ParsedTrackTitle): boolean {
  const rowWords = new Set(row.contextWords);
  return target.contextWords.some((word) => rowWords.has(word));
}

function score(
  target: MatchTarget,
  row: AddonSearchRow,
  targetParts: ParsedTrackTitle,
  rowParts: ParsedTrackTitle,
  artist: ArtistEvidence,
  duration: DurationEvidence,
): number {
  let total = 100;
  if (artist === "exact") total += 25;
  else if (artist === "shared") total += 10;
  if (duration === "tight") total += 40;
  else if (duration === "loose") total += 15;
  if (albumMatches(target, row)) total += 35;
  if (sharesContextWord(targetParts, rowParts)) total += 20;
  return total;
}

export function rowClaimsLossless(row: AddonSearchRow): boolean {
  const text = `${row.format ?? ""} ${row.audioQuality ?? ""}`.toLowerCase();
  return LOSSLESS_CODECS.test(text) || LOSSLESS_TEXTS.some((token) => text.includes(token));
}

/**
 * Whether the row states a codec or quality at all.
 *
 * Some addons (Nebula) leave search rows bare and only name the format when the stream is
 * resolved, so silence is not a lossy claim — the stream answer is what decides.
 */
function rowNamesCodec(row: AddonSearchRow): boolean {
  return `${row.format ?? ""} ${row.audioQuality ?? ""}`.trim() !== "";
}

function compareRanked(left: RankedCandidate, right: RankedCandidate): number {
  const losslessDelta =
    Number(rowClaimsLossless(right.candidate.row)) - Number(rowClaimsLossless(left.candidate.row));
  if (losslessDelta !== 0) return losslessDelta;
  if (left.score !== right.score) return right.score - left.score;
  return left.candidate.sourceOrder - right.candidate.sourceOrder;
}

export function rankAddonCandidates(
  target: MatchTarget,
  candidates: MatchCandidate[],
  options: { allowLossy?: boolean } = {},
): RankedCandidate[] {
  const allowLossy = options.allowLossy ?? false;
  const targetParts = parseTrackTitle(target.title);
  const ranked: RankedCandidate[] = [];

  for (const candidate of candidates) {
    const row = candidate.row;
    if (!allowLossy && rowNamesCodec(row) && !rowClaimsLossless(row)) continue;

    const rowParts = parseTrackTitle(row.title);
    if (!titleCoreMatches(targetParts, rowParts)) continue;
    if (
      !sameSet(
        versionMarkersFor(targetParts, target.album),
        versionMarkersFor(rowParts, row.album),
      )
    ) {
      continue;
    }

    const artist = artistEvidence(target, row);
    if (artist === "rejected") continue;
    const duration = durationEvidence(target.durationSec, row.durationSec);
    if (duration === "rejected") continue;

    ranked.push({
      candidate,
      score: score(target, row, targetParts, rowParts, artist, duration),
    });
  }

  const targetSec = target.durationSec;
  if (targetSec !== undefined) {
    const nearTarget = (rowSec: number | undefined): boolean =>
      rowSec !== undefined && Math.abs(rowSec - targetSec) <= 3;
    const hasWindow = ranked.some((entry) => nearTarget(entry.candidate.row.durationSec));
    if (hasWindow) {
      return ranked
        .filter((entry) => {
          const rowSec = entry.candidate.row.durationSec;
          return rowSec === undefined || nearTarget(rowSec);
        })
        .sort(compareRanked);
    }
  }

  return ranked.sort(compareRanked);
}
