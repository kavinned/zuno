/**
 * Apple Music catalog lookups for motion artwork.
 *
 * Everything here degrades to `null`: a missing token, a dead CDN, an unrecognized response or
 * a failed match must leave the lyrics screen exactly as it was. Results — including misses —
 * are cached for the session so skipping back and forth never repeats a lookup.
 */
import { tauriFetch } from "../youtube/tauriFetch";
import {
  albumForLookup,
  albumIdOf,
  durationAgrees,
  isCompilation,
  matches,
  motionCacheKey,
  motionUrls,
  obj,
  ranked,
  scriptPathFromPage,
  songTerm,
  storefrontFor,
  str,
  webPlayerTokenFromScript,
  type AppleMotion,
  type Json,
} from "./motion";

export interface MotionQuery {
  title: string;
  artist: string;
  album?: string | null;
  durationSec?: number | null;
}

const API = "https://amp-api.music.apple.com/v1/catalog";
const MUSIC_ORIGIN = "https://music.apple.com";
const TOKEN_RETRY_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const cache = new Map<string, AppleMotion | null>();
let tokenPromise: Promise<string | null> | null = null;
let tokenRetryAt = 0;

export async function getTrackMotion(query: MotionQuery): Promise<AppleMotion | null> {
  const album = albumForLookup(query.album);
  const key = motionCacheKey(query.title, query.artist, album, query.durationSec);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const { motion, cacheable } = await lookup({ ...query, album });
  if (cacheable) cache.set(key, motion);
  return motion;
}

interface LookupResult {
  motion: AppleMotion | null;
  /** False for transport/token failures: those may recover, so the next open retries. */
  cacheable: boolean;
}

async function lookup(query: MotionQuery): Promise<LookupResult> {
  const storefront = storefrontFor(navigator.language);
  const album = query.album ?? null;
  const songs = await search(storefront, songTerm(query.title, query.artist, album), "songs");
  if (!songs.ok) return { motion: null, cacheable: false };

  for (const song of ranked(songs.hits, query.title, query.artist, album)) {
    const attributes = obj(song.attributes);
    if (!attributes) continue;
    if (!matches(
      {
        title: str(attributes.name) || null,
        artist: str(attributes.artistName) || null,
        album: str(attributes.albumName) || null,
      },
      query.title,
      query.artist,
      album,
    )) continue;

    const duration = typeof attributes.durationInMillis === "number"
      ? attributes.durationInMillis
      : null;
    if (!durationAgrees(duration, query.durationSec)) continue;

    const inline = motionUrls(attributes.editorialVideo);
    if (inline) return { motion: inline, cacheable: true };

    const albumId = albumIdOf(song);
    if (!albumId) continue;
    const fromAlbum = await albumMotion(storefront, albumId);
    if (!fromAlbum.ok) return { motion: null, cacheable: false };
    if (fromAlbum.motion) return { motion: fromAlbum.motion, cacheable: true };
  }
  return { motion: null, cacheable: true };
}

async function albumMotion(
  storefront: string,
  albumId: string,
): Promise<{ ok: boolean; motion: AppleMotion | null }> {
  const result = await apiGet(`${storefront}/albums/${albumId}`, { extend: "editorialVideo" });
  if (!result.ok) return { ok: false, motion: null };
  const data = result.body?.data;
  const album = Array.isArray(data) ? obj(data[0]) : null;
  const attributes = obj(album?.attributes);
  if (!attributes) return { ok: true, motion: null };
  // The song matched, but its album relationship can still point at a various-artists disc.
  if (isCompilation(str(attributes.name))) return { ok: true, motion: null };
  return { ok: true, motion: motionUrls(attributes.editorialVideo) };
}

async function search(
  storefront: string,
  term: string,
  types: "songs" | "albums",
): Promise<{ ok: boolean; hits: Json[] }> {
  const result = await apiGet(`${storefront}/search`, {
    term,
    types,
    limit: "10",
    extend: "editorialVideo",
    include: "albums",
  });
  if (!result.ok) return { ok: false, hits: [] };
  const data = obj(obj(result.body?.results)?.[types])?.data;
  if (!Array.isArray(data)) return { ok: false, hits: [] };
  return { ok: true, hits: data.map((entry) => obj(entry)).filter((entry): entry is Json => entry !== null) };
}

type ApiResult = { ok: true; body: Json | null } | { ok: false };

async function apiGet(
  path: string,
  params: Record<string, string>,
  allowTokenRetry = true,
): Promise<ApiResult> {
  const token = await getToken();
  if (token === null) return { ok: false };

  const url = new URL(`${API}/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  try {
    const response = await tauriFetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: MUSIC_ORIGIN,
        Referer: `${MUSIC_ORIGIN}/`,
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 401 && allowTokenRetry) {
      // The bundle rotates its token: drop this one and scrape a fresh one exactly once.
      tokenPromise = null;
      tokenRetryAt = 0;
      return apiGet(path, params, false);
    }
    if (!response.ok) return { ok: false };
    return { ok: true, body: obj(await response.json()) };
  } catch {
    return { ok: false };
  }
}

async function getToken(): Promise<string | null> {
  if (tokenPromise !== null) return tokenPromise;
  if (Date.now() < tokenRetryAt) return null;

  tokenPromise = scrapeToken();
  const token = await tokenPromise;
  if (token === null) {
    tokenPromise = null;
    tokenRetryAt = Date.now() + TOKEN_RETRY_MS;
  }
  return token;
}

/**
 * The anonymous token the web player itself uses.
 *
 * A developer token would be the documented route, but it is not available to an app with no
 * developer account; the bundle's token is what the player ships to every visitor anyway.
 */
async function scrapeToken(): Promise<string | null> {
  const page = await fetchText(`${MUSIC_ORIGIN}/us/browse`);
  const scriptPath = page === null ? null : scriptPathFromPage(page);
  if (scriptPath === null) return null;
  const script = await fetchText(`${MUSIC_ORIGIN}${scriptPath}`);
  return script === null ? null : webPlayerTokenFromScript(script);
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await tauriFetch(url, {
      headers: { Origin: MUSIC_ORIGIN, Referer: `${MUSIC_ORIGIN}/` },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}
