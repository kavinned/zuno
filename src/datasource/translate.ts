import { getCachedJson, setCachedJson, onClearCache } from "../internal/cache";
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

const MAX_MEMORY_ENTRIES = 60;
const memoryCache = new Map<string, string[]>();

onClearCache(() => {
  memoryCache.clear();
});

export function clearTranslateMemoryCache(): void {
  memoryCache.clear();
}

function getMemoryCache(key: string): string[] | undefined {
  const value = memoryCache.get(key);
  if (value) {
    // refresh LRU
    memoryCache.delete(key);
    memoryCache.set(key, value);
  }
  return value;
}

function setMemoryCache(key: string, value: string[]): void {
  if (memoryCache.has(key)) {
    memoryCache.delete(key);
  } else if (memoryCache.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) {
      memoryCache.delete(oldest);
    }
  }
  memoryCache.set(key, value);
}

/**
 * Lightweight deterministic content fingerprint to detect lyric line changes or source switches.
 */
export function getLyricsFingerprint(lines: string[]): string {
  let hash = 0;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      hash = ((hash << 5) - hash + line.charCodeAt(i)) | 0;
    }
  }
  return `${lines.length}_${(hash >>> 0).toString(36)}`;
}

/**
 * Returns translated or romanized lines immediately if they are already in memory,
 * eliminating the flash of untranslated lyrics when replaying songs.
 */
export function getCachedTranslationsSync(
  lines: string[],
  targetLangOrMode: string,
  cacheKey?: string,
): string[] | null {
  if (!cacheKey || lines.length === 0) return null;
  const fp = getLyricsFingerprint(lines);
  const key = targetLangOrMode === "rm"
    ? `lyrics:romanize:v2:${cacheKey}:${fp}`
    : `lyrics:translation:v2:${targetLangOrMode}:${cacheKey}:${fp}`;
  const cached = getMemoryCache(key);
  if (cached && cached.length === lines.length) return cached;
  return null;
}

/**
 * Checks whether translated or romanized lines exist in memory or disk cache.
 */
export async function isTranslationCached(
  lines: string[],
  targetLangOrMode: string,
  cacheKey?: string,
): Promise<boolean> {
  if (!cacheKey || lines.length === 0) return false;
  const fp = getLyricsFingerprint(lines);
  const key = targetLangOrMode === "rm"
    ? `lyrics:romanize:v2:${cacheKey}:${fp}`
    : `lyrics:translation:v2:${targetLangOrMode}:${cacheKey}:${fp}`;
  if (getMemoryCache(key)) return true;
  const disk = await getCachedJson<string[]>(key);
  return disk?.length === lines.length;
}

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
export function alignChunk(translated: string, lineCount: number, delimiter = "\n"): string[] | null {
  const parts = translated.split(delimiter);
  if (parts.length !== lineCount) return null;
  return parts.map((part) => part.trim());
}

let lastTranslateError: string | null = null;
let googleRateLimitedUntil = 0;

export function getLastTranslateError(): string | null {
  return lastTranslateError;
}

export function clearLastTranslateError(): void {
  lastTranslateError = null;
}

export function isGoogleRateLimited(): boolean {
  return Date.now() < googleRateLimitedUntil;
}

export function resetGoogleRateLimitCooldown(): void {
  googleRateLimitedUntil = 0;
}

/**
 * Heuristic script and stopword detection to infer source language code for fallback translation APIs.
 */
export function detectScriptLanguage(text: string, targetLang = "en"): string {
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return "ja";
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return "ko";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  if (/[\u0900-\u097F]/.test(text)) return "hi";
  if (/[\u0600-\u06FF]/.test(text)) return "ar";

  if (targetLang !== "en") return "en";

  // When target is English, score common Latin-script languages from frequent words
  const scores: Record<string, number> = {
    es: (text.match(/\b(el|los|las|del|por|para|pero|quiero|estoy|como|cuando)\b/gi) ?? []).length,
    fr: (text.match(/\b(le|les|des|est|dans|pour|avec|nous|vous|cette|tout)\b/gi) ?? []).length,
    de: (text.match(/\b(der|die|das|und|nicht|mit|ein|eine|ist|auf)\b/gi) ?? []).length,
    it: (text.match(/\b(di|che|per|sono|non|della|degli|tutto)\b/gi) ?? []).length,
    pt: (text.match(/\b(os|dos|das|não|uma|mais|muito|isso)\b/gi) ?? []).length,
  };

  let bestLang = "auto";
  let maxScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      bestLang = lang;
    }
  }

  return bestLang;
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function requestMyMemoryTranslation(
  text: string,
  sourceLang: string,
  targetLang: string,
): Promise<string | null> {
  const src = sourceLang === "auto" ? "en" : sourceLang;
  if (src === targetLang) return text;

  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${targetLang}`;
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      responseData?: { translatedText?: string };
      responseStatus?: number;
    };
    if (data.responseStatus !== 200 || !data.responseData?.translatedText) {
      return null;
    }
    const translated = decodeHtmlEntities(data.responseData.translatedText);
    return translated.length > 0 ? translated : null;
  } catch {
    return null;
  }
}

async function requestGoogleTranslation(text: string, targetLang: string): Promise<string | null> {
  if (Date.now() < googleRateLimitedUntil) {
    return null;
  }

  const params = new URLSearchParams({
    client: "dict-chrome-ex",
    sl: "auto",
    tl: targetLang,
    dt: "t",
    q: text,
  });

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    lastTranslateError = "Network offline";
    return null;
  }

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
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!response.ok) {
      if (response.status === 429) {
        googleRateLimitedUntil = Date.now() + 5 * 60_000;
        lastTranslateError = "Rate limit reached (too many requests)";
      } else {
        lastTranslateError = `Service returned HTTP ${response.status}`;
      }
      return null;
    }
    const parsed = parseTranslateResponse(await response.json());
    if (parsed === null) {
      lastTranslateError = "Translation service returned empty response";
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      lastTranslateError = "Request timed out";
    } else {
      lastTranslateError = "Network connection error";
    }
    return null;
  }
}

async function requestTranslation(text: string, targetLang: string): Promise<string | null> {
  // Try primary: Google Translate
  const google = await requestGoogleTranslation(text, targetLang);
  if (google !== null) return google;

  // If offline, do not attempt network fallback
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return null;
  }

  // Fallback: MyMemory keyless translation
  const sourceLang = detectScriptLanguage(text, targetLang);
  if (sourceLang !== targetLang) {
    const fallback = await requestMyMemoryTranslation(text, sourceLang, targetLang);
    if (fallback !== null) {
      lastTranslateError = null;
      return fallback;
    }
  }

  return null;
}

async function requestRomanization(text: string): Promise<string | null> {
  if (Date.now() < googleRateLimitedUntil) {
    lastTranslateError = "Rate limit reached (too many requests)";
    return null;
  }

  // `tl` is required by the endpoint but is ignored when only `dt=rm` is requested.
  const params = new URLSearchParams({
    client: "dict-chrome-ex",
    sl: "auto",
    tl: "en",
    dt: "rm",
    q: text,
  });

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    lastTranslateError = "Network offline";
    return null;
  }

  // Same rationale as requestTranslation — WebView fetch, not the Rust proxy.
  try {
    const response = await fetch(
      `https://translate.googleapis.com/translate_a/single?${params}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      },
    );
    if (!response.ok) {
      if (response.status === 429) {
        googleRateLimitedUntil = Date.now() + 5 * 60_000;
        lastTranslateError = "Rate limit reached (too many requests)";
      } else {
        lastTranslateError = `Service returned HTTP ${response.status}`;
      }
      return null;
    }
    const parsed = parseRomanizeResponse(await response.json());
    if (parsed === null) {
      lastTranslateError = "No romanization returned for this script";
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      lastTranslateError = "Request timed out";
    } else {
      lastTranslateError = "Network connection error";
    }
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
  lastTranslateError = null;
  if (lines.length === 0) return null;

  const key = cacheKey
    ? `lyrics:translation:v2:${targetLang}:${cacheKey}:${getLyricsFingerprint(lines)}`
    : null;
  if (key) {
    const memory = getMemoryCache(key);
    if (memory && memory.length === lines.length) return memory;
    const cached = await getCachedJson<string[]>(key);
    // Length is part of the validity check: a cached run against a different lyric source
    // would align to nothing.
    if (cached?.length === lines.length) {
      setMemoryCache(key, cached);
      return cached;
    }
  }

  const chunks = chunkLines(lines);
  if (chunks.length > MAX_CHUNKS) {
    lastTranslateError = "Lyrics exceed maximum length";
    logInternalWarn("translateLines refused an oversized request", {
      lineCount: lines.length,
      chunkCount: chunks.length,
    });
    return null;
  }

  const translated: string[] = [];
  let anyAligned = false;
  let allAligned = true;

  for (const chunk of chunks) {
    try {
      const result = await requestTranslation(chunk.join("\n"), targetLang);
      const aligned = result === null ? null : alignChunk(result, chunk.length);
      if (aligned) {
        translated.push(...aligned);
        anyAligned = true;
      } else {
        if (result !== null) {
          lastTranslateError = "Could not align translated lines";
        }
        // Blank rather than misaligned: this chunk shows its original lines untranslated.
        translated.push(...chunk.map(() => ""));
        allAligned = false;
      }
    } catch (error) {
      logInternalWarn("translateLines chunk failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      translated.push(...chunk.map(() => ""));
      allAligned = false;
    }
  }

  if (!anyAligned) {
    if (!lastTranslateError) {
      lastTranslateError = "Translation failed to load";
    }
    return null;
  }
  // Only persist complete translations so transient network errors do not poison the cache.
  if (key && allAligned) {
    setMemoryCache(key, translated);
    await setCachedJson(key, translated);
  }
  lastTranslateError = null;
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
  lastTranslateError = null;
  if (lines.length === 0) return null;

  const key = cacheKey
    ? `lyrics:romanize:v2:${cacheKey}:${getLyricsFingerprint(lines)}`
    : null;
  if (key) {
    const memory = getMemoryCache(key);
    if (memory && memory.length === lines.length) return memory;
    const cached = await getCachedJson<string[]>(key);
    if (cached?.length === lines.length) {
      setMemoryCache(key, cached);
      return cached;
    }
  }

  const chunks = chunkLines(lines);
  if (chunks.length > MAX_CHUNKS) {
    lastTranslateError = "Lyrics exceed maximum length";
    logInternalWarn("romanizeLines refused an oversized request", {
      lineCount: lines.length,
      chunkCount: chunks.length,
    });
    return null;
  }

  const romanized: string[] = [];
  let anyAligned = false;
  let allAligned = true;

  for (const chunk of chunks) {
    try {
      /*
       * For CJK scripts (especially Japanese), Google's romanizer collapses newlines into spaces.
       * Joining lines with ' | ' guarantees the line boundary survives romanization across all scripts.
       */
      const sanitized = chunk.map((line) => line.replace(/\|/g, "/"));
      const result = await requestRomanization(sanitized.join(" | "));
      let aligned: string[] | null = null;
      if (result !== null) {
        if (result.includes("|")) {
          aligned = alignChunk(result, chunk.length, "|");
        } else {
          aligned = alignChunk(result, chunk.length, "\n");
        }
      }
      if (aligned) {
        romanized.push(...aligned);
        anyAligned = true;
      } else {
        if (result !== null) {
          lastTranslateError = "Could not align romanized lines";
        }
        romanized.push(...chunk.map(() => ""));
        allAligned = false;
      }
    } catch (error) {
      logInternalWarn("romanizeLines chunk failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      romanized.push(...chunk.map(() => ""));
      allAligned = false;
    }
  }

  if (!anyAligned) {
    if (!lastTranslateError) {
      lastTranslateError = "Romanization failed to load";
    }
    return null;
  }
  // Only persist complete romanizations so transient network errors do not poison the cache.
  if (key && allAligned) {
    setMemoryCache(key, romanized);
    await setCachedJson(key, romanized);
  }
  lastTranslateError = null;
  return romanized;
}
