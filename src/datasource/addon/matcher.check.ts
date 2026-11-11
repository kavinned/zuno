export {};

import type { AddonSearchRow } from "./types";
import {
  rankAddonCandidates,
  rowClaimsLossless,
  type MatchCandidate,
  type MatchTarget,
} from "./matcher";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const target: MatchTarget = {
  title: "Gehra Hua",
  artist: "Arijit Singh",
  album: "Dhurandhar",
  durationSec: 362,
};

function row(overrides: Partial<AddonSearchRow> = {}): AddonSearchRow {
  return {
    id: "tidal:1",
    title: "Gehra Hua",
    artist: "Arijit Singh",
    album: "Dhurandhar",
    durationSec: 362,
    format: "flac",
    ...overrides,
  };
}

function rank(
  rows: AddonSearchRow[],
  options?: { allowLossy?: boolean },
  matchTarget: MatchTarget = target,
): AddonSearchRow[] {
  const candidates: MatchCandidate[] = rows.map((entry, index) => ({
    sourceId: "source",
    sourceOrder: index,
    row: entry,
  }));
  return rankAddonCandidates(matchTarget, candidates, options).map(
    (entry) => entry.candidate.row,
  );
}

equal(rank([row()]).length, 1, "exact title, artist, album and duration match");
equal(rank([row({ artist: "Someone Else" })]).length, 0, "a cover by another artist is rejected");
equal(rank([row({ artist: "" })]).length, 1, "a missing credit does not veto");
equal(rank([row({ title: "Gehra Hua (Live)" })]).length, 0, "a live row is not the studio track");
equal(
  rank([row()], undefined, { ...target, title: "Gehra Hua (Live)" }).length,
  0,
  "a studio row is not the live track",
);
equal(rank([row({ title: "Gehra Hua (Remix)" })]).length, 0, "a remix is not the original");
equal(rank([row({ album: "Karaoke Hits" })]).length, 0, "a karaoke album is a different take");
equal(rank([row({ album: "Instrumental Versions" })]).length, 0, "an instrumental album is a different take");
equal(rank([row({ durationSec: 360 })]).length, 1, "a 2 second difference is accepted");
equal(rank([row({ durationSec: 393 })]).length, 0, "a 31 second difference is rejected");
equal(
  rank([row({ durationSec: undefined })], undefined, { ...target, durationSec: undefined }).length,
  1,
  "no duration on either side is neutral",
);
equal(
  rank([row({ title: 'Gehra Hua (From "Dhurandhar")' })]).length,
  1,
  "film packaging is ignored",
);
equal(
  rank(
    [row({
      title: "Yoru ni Kakeru (夜に駆ける)",
      artist: "YOASOBI",
      durationSec: 261,
    })],
    undefined,
    { title: "夜に駆ける", artist: "YOASOBI", durationSec: 261 },
  ).length,
  1,
  "a bracketed translation matches the CJK core",
);

equal(
  rank(
    [
      row({ id: "mp3", format: "mp3" }),
      row({ id: "flac", format: "flac" }),
    ],
    { allowLossy: true },
  )[0].id,
  "flac",
  "flac outranks mp3 at the same duration",
);
equal(
  rank([row({ id: "mp3", format: "mp3" })]).length,
  0,
  "lossy rows are filtered when lossy fallback is off",
);
equal(
  rank([row({ id: "unclaimed", format: undefined, audioQuality: undefined })]).length,
  1,
  "a row that makes no codec claim is still tried, because the stream answer decides",
);
equal(
  rank([row({ id: "mp3", format: "mp3" })], { allowLossy: true }).length,
  1,
  "lossy rows are eligible when fallback is allowed",
);
equal(
  rank(
    [
      row({ id: "wrong-flac", format: "flac", durationSec: 375 }),
      row({ id: "correct-mp3", format: "mp3", durationSec: 362 }),
    ],
    { allowLossy: true },
  )[0].id,
  "correct-mp3",
  "the duration window beats format quality",
);
equal(
  rank([
    row({ id: "same-1", artist: "Arijit Singh" }),
    row({ id: "same-2", artist: "Arijit Singh" }),
  ])[0].id,
  "same-1",
  "ties keep source order",
);
equal(
  rank([
    row({ id: "no-album", album: undefined }),
    row({ id: "album", album: "Dhurandhar" }),
  ])[0].id,
  "album",
  "album agreement is a confidence tie-break",
);

const karaokeTarget: MatchTarget = { ...target, album: "Karaoke Hits" };
equal(
  rank([row({ album: undefined })], undefined, karaokeTarget).length,
  0,
  "a karaoke target rejects the studio row",
);
equal(
  rank([row({ album: "Karaoke Hits" })], undefined, karaokeTarget).length,
  1,
  "two karaoke takes match",
);
equal(
  rank([row({ title: "Other Song (Gehra Hua)", artist: "Arijit Singh", durationSec: 362 })]).length,
  0,
  "a Latin subtitle does not alias-match a Latin title",
);
equal(
  rank(
    [row({ title: "(New Era)", artist: "KiiiKiii", durationSec: 180 })],
    undefined,
    { ...target, title: "404 (New Era)", artist: "KiiiKiii", durationSec: 179.6 },
  ).length,
  1,
  "a parenthetical-only row matches the target alias",
);
equal(
  rank(
    [row({
      id: "red-velvet",
      title: "Trampoline",
      artist: "Red Velvet",
      album: "Red Velvet - IRENE & SEULGI - TILT - The 2nd Mini Album (2025) [FLAC 16bit-44.1kHz]",
      durationSec: 156,
    })],
    undefined,
    {
      title: "Trampoline",
      artist: "IRENE & SEULGI",
      artists: [{ name: "IRENE & SEULGI" }],
      album: "TILT - The 2nd Mini Album",
      durationSec: 156,
    },
  ).length,
  1,
  "a group credit matches when the album names the subunit artist",
);
equal(
  rowClaimsLossless({ id: "x", title: "t", format: "wave" }),
  false,
  "wave is not a lossless token",
);

const blankAlbumScores = rankAddonCandidates(
  { ...target, album: "   " },
  [
    { sourceId: "source", sourceOrder: 0, row: row({ album: "" }) },
    { sourceId: "source", sourceOrder: 1, row: row({ album: undefined }) },
  ],
).map((entry) => entry.score);
equal(blankAlbumScores[0], blankAlbumScores[1], "a blank album does not earn the album score");

console.log("addon/matcher: ok");
