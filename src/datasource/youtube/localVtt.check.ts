/**
 * Self-check for parseVtt. Run with: bun src/datasource/youtube/localVtt.check.ts
 */
import { parseVtt } from "./localVtt";

function equal(actual: unknown, expected: unknown, message: string): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    throw new Error(`FAIL: ${message}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

const BASIC = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.500 --> 00:00:09.000
Second line
`;

const lines = parseVtt(BASIC);
equal(lines.length, 2, "two cues parsed");
equal(lines[0].text, "Hello world", "first cue text");
equal(lines[0].startTimeSec, 1, "first cue start");
equal(lines[0].endTimeSec, 4, "first cue end");
equal(lines[1].startTimeSec, 5.5, "fractional seconds parsed correctly");

// Cue identifiers should be skipped
const WITH_IDS = `WEBVTT

cue-1
00:00:01.000 --> 00:00:03.000
With identifier

2
00:00:04.000 --> 00:00:06.000
Second cue
`;
const withIds = parseVtt(WITH_IDS);
equal(withIds.length, 2, "cue identifiers are skipped");
equal(withIds[0].text, "With identifier", "text after identifier");

// Cue settings after end timestamp are stripped
const WITH_SETTINGS = `WEBVTT

00:00:01.000 --> 00:00:03.000 align:center
Cue with settings
`;
const withSettings = parseVtt(WITH_SETTINGS);
equal(withSettings.length, 1, "cue settings do not produce extra cues");
equal(withSettings[0].endTimeSec, 3, "end time not mangled by settings");

// HH:MM:SS.mmm format
const HOURS = `WEBVTT

01:02:03.500 --> 01:02:07.000
Long song
`;
const hours = parseVtt(HOURS);
equal(hours[0].startTimeSec, 3723.5, "hours parsed correctly");

// Multi-line cue text is joined with a space
const MULTILINE = `WEBVTT

00:00:01.000 --> 00:00:04.000
Line one
Line two
`;
const multi = parseVtt(MULTILINE);
equal(multi[0].text, "Line one Line two", "multi-line cue joined with space");

console.log("localVtt.check: all assertions passed");
