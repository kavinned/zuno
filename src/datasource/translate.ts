import { getCachedJson, setCachedJson } from "../internal/cache";
import { logInternalWarn } from "../internal/logging";

/**
 * Lyric translation and romanization through Google's undocumented `translate_a` endpoint.
 *
 * This is the endpoint every media player quietly uses; it needs no key and works
 * immediately. It is also undocumented, rate-limited by IP, and can change shape without
 * notice — so everything here treats a failure as normal: a miss returns null, the caller
 * shows the original words, and nothing on the lyrics screen depends on it succeeding.
 *
 * Two modes share the same chunking/alignment/caching machinery:
 * - Translation (`dt=t`): `body[0][i][0]` — target-language text.
 * - Romanization (`dt=rm`): `body[0][i][3]` — source-language Roman-alphabet transcription
 *   (romaji for Japanese, RR for Korean, pinyin for Mandarin, etc.).
 *
 * Swapping in a keyed provider later means replacing the `request*` functions alone; the
 * chunking, alignment and caching above them are provider-agnostic.
 */

/**
 * Characters per request.
 *
 * The endpoint takes the text in the query string, so this is really a URL length budget.
 * Well under the limit on purpose: a request that is refused for length costs a whole chunk
 * of lyrics, while one extra request costs a few hundred milliseconds.
 */
const CHUNK_BUDGET_CHARS = 1200;
/** A song with more chunks than this is not a song; it is a transcript that will get us blocked. */
const MAX_CHUNKS = 12;

/**
 * Groups lines into request-sized chunks without splitting a line across two.
 *
 * Alignment is the whole problem with batch translation: a line must come back as the same
 * line it went in as, so a chunk boundary can only ever fall between lines.
 */
export function chunkLines(lines: string[], budget = CHUNK_BUDGET_CHARS): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;

  for (const line of lines) {
    // +1 for the newline that joins it. A single line over budget still gets its own chunk
    // rather than being dropped — the endpoint can refuse it, and that is a miss, not a bug.
    const cost = line.length + 1;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += cost;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Pulls the translated text out of the endpoint's nested-array response.
 *
 * Shape is `[[[translated, original, ...], ...], ...]` with no schema and no guarantee, so
 * every level is checked. Segments are concatenated because the endpoint splits on sentence
 * boundaries, not on the newlines we sent.
 */
export function parseTranslateResponse(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  const segments = body[0];
  if (!Array.isArray(segments)) return null;

  let text = "";
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === "string") text += segment[0];
  }
  return text.length > 0 ? text : null;
}

/**
 * Pulls the romanized text out of the endpoint's nested-array response.
 *
 * The endpoint returns romanization in `body[0][i][3]` when called with `dt=rm`.
 * Same null-safe shape as `parseTranslateResponse`; absent or non-string slots are skipped.
 */
export function parseRomanizeResponse(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  const segments = body[0];
  if (!Array.isArray(segments)) return null;

  let text = "";
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[3] === "string") text += segment[3];
  }
  return text.length > 0 ? text : null;
}

/**
 * Unicode ranges that signal non-Latin script.
 *
 * When every non-empty line is already Latin text, romanization is a no-op and the network
 * call is skipped. The ranges cover the scripts most commonly found in streamed music:
 * CJK Unified, Hangul, Hiragana, Katakana, Arabic, Devanagari, Cyrillic.
 */
const NON_LATIN_RE =
  /[\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u3000-\u9FFF\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF]/;

/**
 * Returns true when at least one non-empty lyric line contains non-Latin characters.
 *
 * Call this before `romanizeLines` to avoid a pointless request for English-only lyrics.
 */
export function needsRomanization(lines: string[]): boolean {
  return lines.some((line) => line.trim().length > 0 && NON_LATIN_RE.test(line));
}

/**
 * Splits a chunk's translation back into one entry per original line.
 *
 * Returns null on a count mismatch rather than guessing. A translation attached to the wrong
 * line is worse than no translation: it is confidently wrong, and on a lyrics screen the
 * listener has no way to tell.
 */
export function alignChunk(translated: string, lineCount: number): string[] | null {
  const parts = translated.split("\n");
  if (parts.length !== lineCount) return null;
  return parts.map((part) => part.trim());
}

async function requestTranslation(text: string, targetLang: string): Promise<string | null> {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: targetLang,
    dt: "t",
    q: text,
  });

  /*
   * Uses the WebView's native fetch, not the Rust proxy.
   *
   * translate.googleapis.com is a public CORS-enabled endpoint — no authentication is
   * needed and the browser's own HTTP stack is both allowed and preferred. Routing it
   * through the Rust proxy causes 429s because that proxy shares its IP with all YouTube
   * API traffic, making Google classify the combined traffic as automated.
   */
  try {
    const response = await fetch(
      `https://translate.googleapis.com/translate_a/single?${params}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    return parseTranslateResponse(await response.json());
  } catch {
    return null;
  }
}

async function requestRomanization(text: string): Promise<string | null> {
  // `tl` is required by the endpoint but is ignored when only `dt=rm` is requested.
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: "en",
    dt: "rm",
    q: text,
  });

  // Same rationale as requestTranslation — WebView fetch, not the Rust proxy.
  try {
    const response = await fetch(
      `https://translate.googleapis.com/translate_a/single?${params}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) return null;
    return parseRomanizeResponse(await response.json());
  } catch {
    return null;
  }
}

/**
 * Translates lines, preserving one output per input.
 *
 * Entries the endpoint could not align are returned as empty strings, so the caller can show
 * the original alone for those and the translation for the rest.
 */
export async function translateLines(
  lines: string[],
  targetLang: string,
  cacheKey?: string,
): Promise<string[] | null> {
  if (lines.length === 0) return null;

  const key = cacheKey ? `lyrics:translation:v1:${targetLang}:${cacheKey}` : null;
  if (key) {
    const cached = await getCachedJson<string[]>(key);
    // Length is part of the validity check: a cached run against a different lyric source
    // would align to nothing.
    if (cached?.length === lines.length) return cached;
  }

  const chunks = chunkLines(lines);
  if (chunks.length > MAX_CHUNKS) {
    logInternalWarn("translateLines refused an oversized request", {
      lineCount: lines.length,
      chunkCount: chunks.length,
    });
    return null;
  }

  const translated: string[] = [];
  let anyAligned = false;

  for (const chunk of chunks) {
    try {
      const result = await requestTranslation(chunk.join("\n"), targetLang);
      const aligned = result === null ? null : alignChunk(result, chunk.length);
      if (aligned) {
        translated.push(...aligned);
        anyAligned = true;
      } else {
        // Blank rather than misaligned: this chunk shows its original lines untranslated.
        translated.push(...chunk.map(() => ""));
      }
    } catch (error) {
      logInternalWarn("translateLines chunk failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      translated.push(...chunk.map(() => ""));
    }
  }

  if (!anyAligned) return null;
  if (key) await setCachedJson(key, translated);
  return translated;
}

/**
 * Romanizes lines, preserving one output per input.
 *
 * Only meaningful for non-Latin scripts — call `needsRomanization` first to avoid firing
 * pointless requests for English-only lyrics. Entries the endpoint could not align are
 * returned as empty strings so the caller can skip them without disrupting the index mapping.
 */
export async function romanizeLines(
  lines: string[],
  cacheKey?: string,
): Promise<string[] | null> {
  if (lines.length === 0) return null;

  const key = cacheKey ? `lyrics:romanize:v1:${cacheKey}` : null;
  if (key) {
    const cached = await getCachedJson<string[]>(key);
    if (cached?.length === lines.length) return cached;
  }

  const chunks = chunkLines(lines);
  if (chunks.length > MAX_CHUNKS) {
    logInternalWarn("romanizeLines refused an oversized request", {
      lineCount: lines.length,
      chunkCount: chunks.length,
    });
    return null;
  }

  const romanized: string[] = [];
  let anyAligned = false;

  for (const chunk of chunks) {
    try {
      const result = await requestRomanization(chunk.join("\n"));
      const aligned = result === null ? null : alignChunk(result, chunk.length);
      if (aligned) {
        romanized.push(...aligned);
        anyAligned = true;
      } else {
        romanized.push(...chunk.map(() => ""));
      }
    } catch (error) {
      logInternalWarn("romanizeLines chunk failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      romanized.push(...chunk.map(() => ""));
    }
  }

  if (!anyAligned) return null;
  if (key) await setCachedJson(key, romanized);
  return romanized;
}
