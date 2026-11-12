/**
 * Pure helpers behind the Apple Music motion-artwork lookup.
 *
 * Kept free of network and React so the matching rules — which are what protect the UI from
 * showing the wrong album's clip — can be exercised by hand-rolled checks.
 */

export type Json = Record<string, unknown>;

export interface AppleMotion {
  url: string;
  fallbackUrl: string | null;
}

/** Below this, even the only search hit is dropped: a wrong clip is worse than none. */
export const MIN_SCORE = 12;

export function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Json
    : null;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const ARTIST_SEPARATOR = /\s*(?:,|&|×| x |feat\.?|ft\.?|featuring|with)\s*/i;

export function splitArtists(raw: string): string[] {
  return raw
    .split(ARTIST_SEPARATOR)
    .map(normalizeForMatch)
    .filter(Boolean);
}

const COMPILATION_MARKERS = [
  "playlist",
  "set list",
  "essentials",
  "dj mix",
  "mixed",
  "apple music",
  "today's hits",
  "session",
];

export function isCompilation(name: string): boolean {
  const normalized = normalizeForMatch(name);
  return COMPILATION_MARKERS.some((marker) => normalized.includes(normalizeForMatch(marker)));
}

const EDITION_WORDS = ["deluxe", "expanded", "remastered", "remix", "version", "edit", "mix", "bonus"];

function editionWords(text: string): Set<string> {
  const tokens = new Set(normalizeForMatch(text).split(" ").filter(Boolean));
  return new Set(EDITION_WORDS.filter((word) => tokens.has(word)));
}

function fuzzy(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Scores one catalog hit against the wanted track, or rejects it outright.
 *
 * Rejection (null) is deliberate for a wrong artist or a compilation: search is free text and
 * returns those often, and a score floor alone would let an exact-title compilation through.
 */
export function score(
  hit: Json,
  title: string,
  artist: string,
  album: string | null,
  albumIsSelf = false,
): number | null {
  const attributes = obj(hit.attributes);
  if (!attributes) return null;

  const wantedTitle = normalizeForMatch(title);
  const wantedArtists = splitArtists(artist);
  const hitArtists = splitArtists(str(attributes.artistName));
  if (!wantedTitle || wantedArtists.length === 0 || hitArtists.length === 0) return null;
  if (!wantedArtists.every((wanted) => hitArtists.includes(wanted))) return null;

  const hitName = normalizeForMatch(str(attributes.name));
  const hitAlbum = normalizeForMatch(albumIsSelf ? str(attributes.name) : str(attributes.albumName));
  const compilationName = albumIsSelf ? hitName : hitAlbum;
  if (compilationName && isCompilation(compilationName)) return null;

  let total = 10;
  if (hitName === wantedTitle) total += 15;
  else if (fuzzy(hitName, wantedTitle)) total += 7;
  else total -= 10;

  const wantedAlbum = album ? normalizeForMatch(album) : "";
  if (wantedAlbum) {
    if (hitAlbum === wantedAlbum) total += 20;
    else if (fuzzy(hitAlbum, wantedAlbum)) total += 10;
  }

  const hitEditions = editionWords(`${hitName} ${hitAlbum}`);
  const wantedEditions = editionWords(`${wantedTitle} ${wantedAlbum}`);
  for (const word of hitEditions) total += wantedEditions.has(word) ? 5 : -3;

  return total >= MIN_SCORE ? total : null;
}

export function ranked(
  hits: Json[],
  title: string,
  artist: string,
  album: string | null,
  albumIsSelf = false,
): Json[] {
  return hits
    .map((hit) => ({ hit, value: score(hit, title, artist, album, albumIsSelf) }))
    .filter((entry): entry is { hit: Json; value: number } => entry.value !== null)
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.hit);
}

/** Last check before a URL is handed to the player: the chosen hit must describe the track. */
export function matches(
  found: { title: string | null; artist: string | null; album: string | null },
  title: string,
  artist: string,
  album: string | null,
): boolean {
  if (found.title === null || !fuzzy(normalizeForMatch(found.title), normalizeForMatch(title))) {
    return false;
  }
  const wantedArtists = splitArtists(artist);
  const creditedArtists = splitArtists(found.artist ?? "");
  if (wantedArtists.length === 0 || creditedArtists.length === 0) return false;
  if (!wantedArtists.every((wanted) => creditedArtists.includes(wanted))) return false;

  const wantedAlbum = album ? normalizeForMatch(album) : "";
  const foundAlbum = found.album ? normalizeForMatch(found.album) : "";
  if (wantedAlbum && foundAlbum && !fuzzy(foundAlbum, wantedAlbum)) return false;
  return true;
}

const RENDITIONS = [
  "motionDetailSquare",
  "motionSquareVideo1x1",
  "motionDetailRaw",
  "motionDetailTall",
  "motionTallVideo3x4",
];

export function motionUrls(video: unknown): AppleMotion | null {
  const source = obj(video);
  if (!source) return null;
  const urls = RENDITIONS
    .map((name) => str(obj(source[name])?.video))
    .filter((url) => url.length > 0);
  if (urls.length === 0) return null;
  return { url: urls[0], fallbackUrl: urls.find((url) => url !== urls[0]) ?? null };
}

export function albumIdOf(song: Json): string | null {
  const data = obj(obj(song.relationships)?.albums)?.data;
  const first = Array.isArray(data) ? obj(data[0]) : null;
  const id = str(first?.id);
  if (/^\d+$/.test(id)) return id;

  const url = str(obj(song.attributes)?.url);
  const fromUrl = url.match(/\/album\/[^/]+\/(\d+)/);
  return fromUrl ? fromUrl[1] : null;
}

export function songTerm(title: string, artist: string, album: string | null): string {
  const parts: string[] = [];
  const normalizedTitle = normalizeForMatch(title);
  const normalizedArtist = normalizeForMatch(artist);
  if (normalizedArtist && !normalizedTitle.includes(normalizedArtist)) parts.push(artist.trim());
  if (title.trim()) parts.push(title.trim());
  const normalizedAlbum = album ? normalizeForMatch(album) : "";
  if (normalizedAlbum && !normalizeForMatch(parts.join(" ")).includes(normalizedAlbum)) {
    parts.push(album!.trim());
  }
  return parts.join(" ");
}

/** A duration the two sides cannot agree on means the hit is a different recording. */
export function durationAgrees(
  foundMs: number | null,
  wantSec: number | null | undefined,
  toleranceSec = 10,
): boolean {
  if (foundMs === null || wantSec === null || wantSec === undefined) return true;
  return Math.abs(foundMs / 1000 - wantSec) <= toleranceSec;
}

export function motionCacheKey(
  title: string,
  artist: string,
  album: string | null | undefined,
  durationSec: number | null | undefined,
): string {
  const duration = durationSec === null || durationSec === undefined
    ? ""
    : String(Math.round(durationSec));
  return [
    normalizeForMatch(title),
    normalizeForMatch(artist),
    normalizeForMatch(album ?? ""),
    duration,
  ].join("|");
}

export function storefrontFor(locale: string | undefined): string {
  const region = locale?.split("-")[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toLowerCase() : "us";
}

const SCRIPT_PATH = /\/assets\/index(?:-legacy)?[~-][A-Za-z0-9_-]+\.js/;

export function scriptPathFromPage(html: string): string | null {
  return html.match(SCRIPT_PATH)?.[0] ?? null;
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (value.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

export function jwtExpiryMs(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  const decoded = decodeBase64Url(payload);
  if (decoded === null) return null;
  try {
    const exp = obj(JSON.parse(decoded))?.exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * The anonymous web-player token, which is the only one the catalog accepts.
 *
 * Other JWTs in the bundle come back 401, so the choice is made here rather than by trying
 * each one against the API.
 */
export function webPlayerTokenFromScript(script: string, nowMs = Date.now()): string | null {
  for (const match of script.matchAll(JWT_PATTERN)) {
    const token = match[0];
    const expiry = jwtExpiryMs(token);
    if (expiry !== null && expiry <= nowMs) continue;
    const header = decodeBase64Url(token.split(".")[0]) ?? "";
    const payload = decodeBase64Url(token.split(".")[1]) ?? "";
    if (header.includes("WebPlayKid") || payload.includes("AMPWebPlay")) return token;
  }
  return null;
}
