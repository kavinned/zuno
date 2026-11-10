export interface ParsedTrackTitle {
  core: string;
  searchText: string;
  aliases: string[];
  versionMarkers: string[];
  contextWords: string[];
}

const NEUTRAL_LABELS = ["album version", "radio edit", "original mix", "deluxe version"];

/** Canonical English marker, its Latin spellings, then its Japanese spellings. */
const VERSION_MARKERS: ReadonlyArray<
  readonly [string, readonly string[], readonly string[]]
> = [
  ["remix", ["remix"], ["リミックス"]],
  ["live", ["live"], ["ライブ", "ライヴ"]],
  ["acoustic", ["acoustic"], ["アコースティック"]],
  ["instrumental", ["instrumental"], ["インストゥルメンタル", "インスト"]],
  ["karaoke", ["karaoke"], ["カラオケ"]],
  ["cover", ["cover"], ["カバー"]],
  ["sped up", ["sped up"], ["スピードアップ"]],
  ["slowed", ["slowed"], ["スロウ"]],
  ["nightcore", ["nightcore"], ["ナイトコア"]],
  ["extended", ["extended"], ["エクステンデッド"]],
  ["edit", ["edit"], ["エディット"]],
  ["demo", ["demo"], ["デモ"]],
  ["reprise", ["reprise"], ["リプライズ"]],
];

const PAREN_BRACKETS = /\(([^()]*)\)/;
const SQUARE_BRACKETS = /\[([^\[\]]*)\]/;
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

function matchesLatin(text: string, spelling: string): boolean {
  const tokens = words(text);
  const wanted = spelling.split(" ");
  return tokens.some((_, index) => wanted.every((token, offset) => tokens[index + offset] === token));
}

function classify(segment: string, parsed: ParsedTrackTitle): void {
  const text = collapse(segment);
  if (!text) return;
  if (NEUTRAL_LABELS.includes(text)) return;
  if (FEAT_HEAD.test(text)) return;

  const markers = VERSION_MARKERS.filter(
    ([, latin, japanese]) =>
      latin.some((spelling) => matchesLatin(text, spelling)) ||
      japanese.some((spelling) => text.includes(spelling)),
  ).map(([canonical]) => canonical);

  if (markers.length > 0) parsed.versionMarkers.push(...markers);
  else parsed.contextWords.push(...words(text));

  const alias = stripPunctuation(text);
  if (alias.length >= 2) parsed.aliases.push(alias);
}

/** Innermost first, regardless of bracket type: the pair whose closing bracket comes first. */
function extractBrackets(text: string): { rest: string; segments: string[] } {
  const segments: string[] = [];
  let rest = text;
  for (;;) {
    const paren = PAREN_BRACKETS.exec(rest);
    const square = SQUARE_BRACKETS.exec(rest);
    const parenEnd = paren ? paren.index + paren[0].length : Infinity;
    const squareEnd = square ? square.index + square[0].length : Infinity;
    const match = parenEnd <= squareEnd ? paren : square;
    if (!match) break;
    const segment = (match[1] ?? "").trim();
    if (segment) segments.push(segment);
    rest = rest.slice(0, match.index) + " " + rest.slice(match.index + match[0].length);
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

  parsed.aliases = unique(parsed.aliases);
  parsed.versionMarkers = unique(parsed.versionMarkers);
  parsed.contextWords = unique(parsed.contextWords);
  parsed.searchText = collapse([titlePart, ...parsed.versionMarkers].join(" "));
  parsed.core = stripPunctuation(titlePart) || parsed.aliases[0] || stripPunctuation(normalized);
  return parsed;
}

export function buildSearchQueries(parts: ParsedTrackTitle, primaryArtist: string): string[] {
  const title = parts.searchText.trim();
  const artist = primaryArtist.normalize("NFKC").toLocaleLowerCase().trim();
  const queries = title && artist ? [`${title} ${artist}`, title] : [title];
  /*
   * Some addon rows keep only the parenthetical (`(New Era)` for `404 (New Era)`), so the title
   * query cannot find them. Context words are the only remaining bridge; try them last.
   */
  const context = parts.contextWords.join(" ").trim();
  if (context) {
    queries.push(...(artist ? [`${context} ${artist}`, context] : [context]));
  }
  return unique(queries.filter((query) => query.length > 0));
}
