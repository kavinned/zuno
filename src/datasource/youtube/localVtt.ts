import type { LyricLine } from "../../datasource/types";

/** Parses `HH:MM:SS.mmm` or `MM:SS.mmm` into seconds. */
function parseVttTimestamp(ts: string): number {
  const parts = ts.trim().split(":");
  if (parts.length === 3) {
    return (
      parseInt(parts[0], 10) * 3600 +
      parseInt(parts[1], 10) * 60 +
      parseFloat(parts[2])
    );
  }
  return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
}

/**
 * Converts a WebVTT string to `LyricLine[]`.
 *
 * Skips the WEBVTT header, NOTE blocks, and cue identifiers.
 * Each cue becomes one `LyricLine` with `startTimeSec` / `endTimeSec`.
 * Multi-line cue text is joined with a space.
 */
export function parseVtt(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");

  let i = 0;
  while (i < rawLines.length && !rawLines[i].includes("WEBVTT")) i++;
  i++;

  while (i < rawLines.length) {
    const line = rawLines[i].trim();
    i++;

    if (!line || line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      continue;
    }

    // A line is a timestamp line if it contains " --> ", otherwise the
    // current line may be a cue identifier — peek at the next line.
    const timestampLine = line.includes(" --> ")
      ? line
      : (rawLines[i]?.includes(" --> ") ? rawLines[i++].trim() : null);
    if (!timestampLine) continue;

    const arrowIdx = timestampLine.indexOf(" --> ");
    const start = parseVttTimestamp(timestampLine.slice(0, arrowIdx));
    // Strip cue settings that may follow the end timestamp
    const endRaw = timestampLine.slice(arrowIdx + 5).split(/\s/)[0];
    const end = parseVttTimestamp(endRaw);

    const textLines: string[] = [];
    while (i < rawLines.length && rawLines[i].trim() !== "") {
      textLines.push(rawLines[i].trim());
      i++;
    }

    const cueText = textLines.join(" ").trim();
    if (cueText) {
      lines.push({ text: cueText, startTimeSec: start, endTimeSec: end });
    }
  }

  return lines;
}
