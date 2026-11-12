import { parseTrackTitle } from "../addon/title";
import {
  sharesNonLatinGlyphs,
  splitNames,
  titleCoreMatches,
  versionMarkersFor,
} from "../addon/matcher";

/** One row from `GET https://lyrics.kugou.com/search`. Durations are milliseconds. */
export interface KugouCandidate {
  id: string;
  accesskey: string;
  song: string;
  singer: string;
  duration: number;
  score?: number;
  product_from?: string;
}

export interface KugouSearchResponse {
  status?: number;
  candidates?: KugouCandidate[];
}

export interface KugouDownloadResponse {
  status?: number;
  content?: string;
  fmt?: string;
  info?: string;
}

/** A download response is usable only when it reports OK and carries a payload. */
export function isUsableKugouDownload(
  body: KugouDownloadResponse,
): body is KugouDownloadResponse & { status: 200; content: string } {
  return body.status === 200 && typeof body.content === "string" && body.content.length > 0;
}

/** The track fields the candidate selector needs; `Track` satisfies this structurally. */
export interface KugouTarget {
  title: string;
  artist: string;
  artists?: Array<{ name: string }>;
  album?: string;
  durationSec?: number;
}

const MAX_DURATION_DELTA_MS = 3_000;

function sameSet(left: string[], right: string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((entry) => b.has(entry));
}

function isUgc(candidate: KugouCandidate): boolean {
  return /ugc/i.test(candidate.product_from ?? "");
}

/**
 * The candidate worth downloading, or undefined.
 *
 * Kugou search mixes official sheets with UGC uploads. Duration, title and singer keep the
 * lyrics tied to this recording; the official-before-UGC sort keeps a high-scoring upload
 * from beating the catalogue version.
 */
export function pickKugouCandidate(
  target: KugouTarget,
  candidates: KugouCandidate[],
): KugouCandidate | undefined {
  const durationSec = target.durationSec;
  if (!durationSec || durationSec <= 0) return undefined;

  const durationMs = durationSec * 1000;
  const targetParts = parseTrackTitle(target.title);
  const targetNames = [
    target.artist,
    ...(target.artists?.map((artist) => artist.name) ?? []),
  ].flatMap((name) => splitNames(name));
  const targetMarkers = versionMarkersFor(targetParts, target.album);

  const qualified = candidates.filter((candidate) => {
    if (
      !Number.isFinite(candidate.duration) ||
      Math.abs(candidate.duration - durationMs) > MAX_DURATION_DELTA_MS
    ) {
      return false;
    }

    const candidateParts = parseTrackTitle(candidate.song);
    if (!titleCoreMatches(targetParts, candidateParts)) return false;
    // Kugou candidates carry no album, so only the candidate's own title markers apply.
    if (!sameSet(targetMarkers, versionMarkersFor(candidateParts, undefined))) {
      return false;
    }

    const candidateNames = splitNames(candidate.singer);
    if (candidateNames.some((name) => targetNames.includes(name))) return true;
    return targetNames.some((name) =>
      candidateNames.some((candidateName) => sharesNonLatinGlyphs(name, candidateName)),
    );
  });

  return [...qualified].sort(
    (left, right) =>
      Number(isUgc(left)) - Number(isUgc(right)) ||
      (right.score ?? 0) - (left.score ?? 0),
  )[0];
}

/** Kugou's `content` is base64-wrapped UTF-8 LRC, often with a BOM and CRLF lines. */
export function decodeKugouLrc(content: string): string {
  const binary = atob(content.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
