export interface ParsedTrackTitle {
  core: string;
  searchText: string;
  aliases: string[];
  versionMarkers: string[];
  contextWords: string[];
}

const NEUTRAL_LABELS = ["album version", "radio edit", "original mix", "deluxe version"];

/** Canonical English marker first, then every spelling that names it. */
const VERSION_MARKERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["remix", ["remix", "リミックス"]],
  ["live", ["live", "ライブ", "ライヴ"]],
  ["acoustic", ["acoustic", "アコースティック"]],
  ["instrumental", ["instrumental", "インストゥルメンタル", "インスト"]],
  ["karaoke", ["karaoke", "カラオケ"]],
  ["cover", ["cover", "カバー"]],
  ["sped up", ["sped up", "スピードアップ"]],
  ["slowed", ["slowed", "スロウ"]],
  ["nightcore", ["nightcore", "ナイトコア"]],
  ["extended", ["extended", "エクステンデッド"]],
  ["edit", ["edit", "エディット"]],
  ["demo", ["demo", "デモ"]],
  ["reprise", ["reprise", "リプライズ"]],
];

const BRACKETS = /\(([^()]*)\)|\[([^\[\]]*)\]/;
const TAIL_SPLIT = /\s+[-–—|]\s+/;
const FEAT_TAIL = /\s+(?:feat\.?|ft\.?|featuring)\b.*$/u;
const FEAT_HEAD = /^(?:feat\.?|ft\.?|featuring)\b/;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function words(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stripPunctuation(text: string): string {
  return text.replace(/[^\p{L}\p{N}]/gu, "");
}

function classify(segment: string, parsed: ParsedTrackTitle): void {
  const text = collapse(segment);
  if (!text) return;
  if (NEUTRAL_LABELS.includes(text)) return;
  if (FEAT_HEAD.test(text)) return;

  const markers = VERSION_MARKERS.filter(([, spellings]) =>
    spellings.some((spelling) => text.includes(spelling)),
  ).map(([canonical]) => canonical);

  if (markers.length > 0) parsed.versionMarkers.push(...markers);
  else parsed.contextWords.push(...words(text));

  const alias = stripPunctuation(text);
  if (alias.length >= 2) parsed.aliases.push(alias);
}

/** Innermost first, repeatedly, so `[Official (Live) Video]` yields `live` then the rest. */
function extractBrackets(text: string): { rest: string; segments: string[] } {
  const segments: string[] = [];
  let rest = text;
  let match = BRACKETS.exec(rest);
  while (match) {
    const segment = (match[1] ?? match[2] ?? "").trim();
    if (segment) segments.push(segment);
    rest = rest.slice(0, match.index) + " " + rest.slice(match.index + match[0].length);
    match = BRACKETS.exec(rest);
  }
  return { rest, segments };
}

export function parseTrackTitle(title: string): ParsedTrackTitle {
  const normalized = title.normalize("NFKC").toLocaleLowerCase().replace(/&/g, "and");
  const { rest, segments } = extractBrackets(normalized);

  const parsed: ParsedTrackTitle = {
    core: "",
    searchText: "",
    aliases: [],
    versionMarkers: [],
    contextWords: [],
  };

  for (const segment of segments) classify(segment, parsed);

  const parts = rest.split(TAIL_SPLIT);
  const titlePart = collapse(parts[0] ?? "").replace(FEAT_TAIL, "").trim();
  for (const tail of parts.slice(1)) classify(tail, parsed);

  parsed.searchText = collapse([titlePart, ...parsed.versionMarkers].join(" "));
  parsed.core = stripPunctuation(titlePart) || parsed.aliases[0] || stripPunctuation(normalized);
  parsed.aliases = unique(parsed.aliases);
  parsed.versionMarkers = unique(parsed.versionMarkers);
  parsed.contextWords = unique(parsed.contextWords);
  return parsed;
}

export function buildSearchQueries(parts: ParsedTrackTitle, primaryArtist: string): string[] {
  const title = parts.searchText.trim();
  const artist = primaryArtist.normalize("NFKC").toLocaleLowerCase().trim();
  const queries = title && artist ? [`${title} ${artist}`, title] : [title];
  return unique(queries.filter((query) => query.length > 0));
}
