export {};

import { buildSearchQueries, parseTrackTitle } from "./title";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const packaged = parseTrackTitle('Gehra Hua (From "Dhurandhar") [Official Video]');
equal(packaged.core, "gehrahua", "packaging is removed from the core");
equal(packaged.searchText, "gehra hua", "packaging is removed from the query text");
check(packaged.contextWords.includes("official"), "official is context");
check(packaged.contextWords.includes("video"), "video is context");
check(packaged.contextWords.includes("dhurandhar"), "film name is context");

equal(parseTrackTitle("Song (Live)").versionMarkers.join(","), "live", "live is a version marker");
equal(
  parseTrackTitle("Song（ライブ）").versionMarkers.join(","),
  "live",
  "full-width Japanese live marker is recognised",
);
equal(
  parseTrackTitle("Song (Radio Edit)").versionMarkers.length,
  0,
  "radio edit is neutral, not a version marker",
);
equal(parseTrackTitle("Song (Album Version)").searchText, "song", "album version is neutral");
equal(parseTrackTitle("Song - Remastered").versionMarkers.length, 0, "remaster is context");
check(
  parseTrackTitle("Song - Remastered").contextWords.includes("remastered"),
  "remaster stays as context",
);
equal(parseTrackTitle("Song feat. Guest").core, "song", "feat tail is removed");
equal(parseTrackTitle("Song & Dance").searchText, "song and dance", "ampersand becomes and");
equal(parseTrackTitle("Ｓｏｎｇ（Ｌｉｖｅ）").core, "song", "NFKC normalizes full-width text");
equal(parseTrackTitle("夜に駆ける").core, "夜に駆ける", "CJK core is preserved");
check(
  parseTrackTitle("Yoru ni Kakeru (夜に駆ける)").aliases.includes("夜に駆ける"),
  "bracketed translation is kept as an alias",
);

equal(
  parseTrackTitle("Song (Live)").searchText,
  "song live",
  "version markers stay in the search text",
);
equal(
  JSON.stringify(
    buildSearchQueries(parseTrackTitle("Song (Official Video) feat. Guest"), "Artist"),
  ),
  JSON.stringify(["song artist", "song"]),
  "title plus artist, then title alone",
);
equal(
  JSON.stringify(buildSearchQueries(parseTrackTitle("Song"), "")),
  JSON.stringify(["song"]),
  "no artist means one query",
);
equal(
  JSON.stringify(buildSearchQueries(parseTrackTitle("Song (Live)"), "Artist")),
  JSON.stringify(["song live artist", "song live"]),
  "a version marker is carried into the query",
);

const mixed = parseTrackTitle("Song [Official (Live) Video]");
equal(mixed.versionMarkers.join(","), "live", "inner live marker is extracted first");
check(mixed.contextWords.includes("official"), "outer official is context");
check(mixed.contextWords.includes("video"), "outer video is context");
check(!mixed.aliases.includes("officiallivevideo"), "the outer alias does not swallow the inner marker");

equal(
  parseTrackTitle("Song (Live) - Live").searchText,
  "song live",
  "duplicate markers appear once in searchText",
);

equal(
  parseTrackTitle("Song (Deluxe Edition)").versionMarkers.length,
  0,
  "edition is not an edit marker",
);
equal(
  parseTrackTitle("Song (Alive)").versionMarkers.length,
  0,
  "alive is not a live marker",
);

console.log("addon/title: ok");
