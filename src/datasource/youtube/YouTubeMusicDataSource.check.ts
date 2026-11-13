/**
 * Self-checks for the YouTube Music parser pieces that live as pure functions: the
 * multi-account switch/remove outcome (`removeAccountOutcome`), the artist named by a bare
 * subtitle (`artistFromSubtitle`), and the album a song row points at (`trackAlbumFromItem`).
 */
export {};

import {
  artistFromSubtitle,
  removeAccountOutcome,
  trackAlbumFromItem,
} from "./YouTubeMusicDataSource";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

// Removing an account that was not active must not disturb the current session at all.
check(
  removeAccountOutcome("cookie-a", "cookie-a") === "unchanged",
  "same cookie before and after means the removed account was not the active one",
);

// Removing the active account with another stored one falls back to it.
check(
  removeAccountOutcome("cookie-a", "cookie-b") === "switched",
  "a different, non-null cookie afterward means another stored account took over",
);

// Removing the last account leaves nothing active.
check(
  removeAccountOutcome("cookie-a", null) === "signed-out",
  "no cookie afterward means that was the last stored account",
);

// Removing the only account while never having been signed in is still a no-op, not a crash.
check(
  removeAccountOutcome(null, null) === "unchanged",
  "null before and after must not be read as switching to 'no one'",
);

console.log("YouTubeMusicDataSource.removeAccountOutcome: ok");

// An album card on an artist's own page names no artist; its year is not one (#169).
check(artistFromSubtitle("Album • 2021") === undefined, "type and year alone name no artist");
check(artistFromSubtitle("2016") === undefined, "a bare year is not an artist");
check(artistFromSubtitle("Radiohead • 1995") === "Radiohead", "an artist beside a year survives");
check(artistFromSubtitle("Single • The 1975") === "The 1975", "a name containing digits is still a name");
check(artistFromSubtitle(undefined) === undefined, "no subtitle, no artist");

console.log("YouTubeMusicDataSource.artistFromSubtitle: ok");

// A song row renders "artist • album • duration" in one linked column. Taking the whole column
// text made the album `IVE • IVE SECRET • 2:34`, which then failed every album comparison —
// including the Apple Music motion lookup, which is why search-opened tracks lost their clip.
const browseIdOf = (run: { endpoint?: unknown; navigationEndpoint?: unknown }): string | undefined => {
  const endpoint = run.endpoint as { payload?: { browseId?: string } } | undefined;
  return endpoint?.payload?.browseId;
};

const songRow = {
  flex_columns: [
    {
      title: {
        toString: () => "Noun",
        runs: [{ text: "Noun", endpoint: { payload: { browseId: "UCartist" } } }],
      },
    },
    {
      title: {
        toString: () => "IVE • IVE SECRET • 2:34",
        runs: [
          { text: "IVE", endpoint: { payload: { browseId: "UCartist" } } },
          { text: " • " },
          { text: "IVE SECRET", endpoint: { payload: { browseId: "MPREalbum" } } },
          { text: " • " },
          { text: "2:34" },
        ],
      },
    },
  ],
};

check(
  trackAlbumFromItem(songRow, browseIdOf).name === "IVE SECRET",
  "only the album-linked run names the album",
);
check(
  trackAlbumFromItem(songRow, browseIdOf).id === "MPREalbum",
  "the album's browse id comes back with its name",
);
check(
  trackAlbumFromItem(
    { flex_columns: [{ title: { toString: () => "IVE" } }, { title: { toString: () => "IVE", runs: [{ text: "IVE" }] } }] },
    browseIdOf,
  ).name === undefined,
  "a column with no album link names no album",
);
check(
  trackAlbumFromItem({}, browseIdOf).name === undefined,
  "a row with no columns names no album",
);

console.log("YouTubeMusicDataSource.trackAlbumFromItem: ok");
