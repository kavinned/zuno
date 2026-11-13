export {};

import {
  albumForLookup,
  albumIdOf,
  durationAgrees,
  isCompilation,
  jwtExpiryMs,
  matches,
  motionCacheKey,
  motionUrls,
  normalizeForMatch,
  ranked,
  scriptPathFromPage,
  songTerm,
  splitArtists,
  storefrontFor,
  webPlayerTokenFromScript,
} from "./motion";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const song = (name: string, artistName: string, albumName: string, url = "") =>
  ({ attributes: { name, artistName, albumName, url } });

equal(normalizeForMatch("Beyoncé - CRAZY (feat. JAY-Z)"), "beyonce crazy feat jay z", "folds accents and punctuation");
equal(splitArtists("A, B & C x D feat. E").join("|"), "a|b|c|d|e", "splits every credit separator");
check(isCompilation("Today's Hits"), "playlist names are compilations");
check(!isCompilation("Midnights"), "albums are not compilations");

const hits = [
  song("Lavender Haze", "Taylor Swift", "Midnights"),
  song("Anti-Hero", "Taylor Swift", "Midnights"),
  song("Anti-Hero", "Someone Else", "Midnights"),
  song("Anti-Hero", "Taylor Swift", "Today's Hits"),
];
const ordered = ranked(hits, "Anti-Hero", "Taylor Swift", "Midnights");
equal(ordered[0], hits[1], "the exact song ranks first");
check(!ordered.includes(hits[2]), "a different artist is rejected");
check(!ordered.includes(hits[3]), "a compilation is rejected");
check(!matches({ title: "Lavender Haze", artist: "Taylor Swift", album: "Midnights" }, "Anti-Hero", "Taylor Swift", "Midnights"), "re-check rejects another song");

const plain = { attributes: { name: "Midnights", artistName: "Taylor Swift" } };
const deluxe = { attributes: { name: "Midnights (Deluxe)", artistName: "Taylor Swift" } };
equal(ranked([deluxe, plain], "Midnights", "Taylor Swift", "Midnights", true)[0], plain, "plain album beats deluxe");

equal(
  JSON.stringify(motionUrls({ motionDetailTall: { video: "tall.m3u8" }, motionDetailSquare: { video: "square.m3u8" } })),
  JSON.stringify({ url: "square.m3u8", fallbackUrl: "tall.m3u8" }),
  "square first, tall as fallback",
);
check(motionUrls({}) === null, "no asset means no motion");
equal(albumIdOf({ relationships: { albums: { data: [{ id: "1649434004" }] } } }), "1649434004", "album id from relationship");
equal(albumIdOf({ attributes: { url: "https://music.apple.com/us/album/x/1649434004?i=1" } }), "1649434004", "album id from URL");
check(albumIdOf({ relationships: { albums: { data: [{ id: "pl.1" }] } } }) === null, "playlist ids are rejected");
equal(songTerm("Anti-Hero", "Taylor Swift", "Midnights"), "Taylor Swift Anti-Hero Midnights", "search term folds what is known");
equal(songTerm("Taylor Swift - Anti-Hero", "Taylor Swift", null), "Taylor Swift - Anti-Hero", "artist already in title is not repeated");

check(durationAgrees(194_000, 194, 10), "matching durations pass");
check(durationAgrees(null, 194, 10), "unknown hit duration passes");
check(durationAgrees(194_000, undefined, 10), "unknown wanted duration passes");
check(durationAgrees(204_000, 194, 10), "durations exactly ten seconds apart pass");
check(!durationAgrees(204_500, 194, 10), "durations past ten seconds apart are rejected");
check(!durationAgrees(300_000, 194, 10), "durations far apart are rejected");

equal(storefrontFor("en-GB"), "gb", "storefront from locale");
equal(storefrontFor("en"), "us", "storefront falls back to us");
equal(storefrontFor(undefined), "us", "missing locale falls back to us");

equal(
  scriptPathFromPage('<script src="/assets/index~abc123.js"></script>'),
  "/assets/index~abc123.js",
  "finds the web-player bundle",
);
check(scriptPathFromPage("<html></html>") === null, "a page without a bundle returns null");

const b64url = (value: unknown): string =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const payload = b64url({ exp: 2_000_000_000 });
const header = b64url({ kid: "WebPlayKid" });
const goodToken = `${header}.${payload}.signature`;
equal(jwtExpiryMs(goodToken), 2_000_000_000_000, "reads JWT expiry");
equal(webPlayerTokenFromScript(`x"${goodToken}"y`, 1_000_000_000_000), goodToken, "picks the web-player token");
check(webPlayerTokenFromScript(`x"${goodToken}"y`, 2_100_000_000_000) === null, "expired tokens are not used");

equal(motionCacheKey(" Anti-Hero ", "Taylor Swift", "Midnights", 194), "anti hero|taylor swift|midnights|194", "cache key is normalized");

/*
 * YouTube song rows used to hand over "artist • album • duration" as the album, and rows
 * cached or persisted before the parser fix still do. An album the lookup cannot recognise is
 * worse than none: it fails the album gate every time.
 */
equal(albumForLookup("IVE • IVE SECRET • 2:34"), null, "a subtitle-shaped album is dropped");
equal(albumForLookup("Midnights (3am Edition)"), "Midnights (3am Edition)", "a real album is kept");
equal(albumForLookup(null), null, "no album stays none");

console.log("motion.check.ts passed");
