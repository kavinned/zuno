import {
  decodeKugouLrc,
  isUsableKugouDownload,
  pickKugouCandidate,
  type KugouCandidate,
  type KugouTarget,
} from "./kugou";

export {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function target(overrides: Partial<KugouTarget> = {}): KugouTarget {
  return { title: "Numb", artist: "Linkin Park", durationSec: 187.593, ...overrides };
}

function candidate(overrides: Partial<KugouCandidate> = {}): KugouCandidate {
  return {
    id: "274944371",
    accesskey: "2A7B",
    song: "Numb",
    singer: "Linkin Park",
    duration: 187_593,
    score: 60,
    product_from: "官方推荐歌词",
    ...overrides,
  };
}

equal(pickKugouCandidate(target(), [candidate()])?.id, "274944371", "an exact candidate is chosen");
equal(
  pickKugouCandidate(target(), [candidate({ singer: "Cover Artist" })]),
  undefined,
  "a cover by another singer is rejected",
);
equal(
  pickKugouCandidate(target(), [candidate({ song: "Numb (Live)" })]),
  undefined,
  "a live version is rejected",
);
equal(
  pickKugouCandidate(target({ album: "Instrumental Covers Vol. 2" }), [candidate()]),
  undefined,
  "a vocal candidate is rejected for an instrumental album",
);
equal(
  pickKugouCandidate(target(), [candidate({ duration: 191_000 })]),
  undefined,
  "a candidate more than three seconds away is rejected",
);
equal(
  pickKugouCandidate(target({ title: "演员", artist: "薛之谦", durationSec: 261.25 }), [
    candidate({ id: "CNA", song: "演员", singer: "薛之謙", duration: 261_250 }),
  ])?.id,
  "CNA",
  "traditional and simplified singer credits still match",
);
equal(
  pickKugouCandidate(target(), [candidate({ id: "LOW", score: 10 }), candidate({ id: "HIGH", score: 90 })])?.id,
  "HIGH",
  "higher score wins",
);
equal(
  pickKugouCandidate(target(), [
    candidate({ id: "UGC", score: 99, product_from: "ugc" }),
    candidate({ id: "OFFICIAL", score: 10, product_from: "官方推荐歌词" }),
  ])?.id,
  "OFFICIAL",
  "an official candidate outranks a higher-scoring UGC one",
);
equal(
  pickKugouCandidate(target({ durationSec: undefined }), [candidate()]),
  undefined,
  "a track with no duration cannot be matched",
);
equal(pickKugouCandidate(target(), []), undefined, "no candidates is undefined, not a crash");

check(
  isUsableKugouDownload({ status: 200, content: "abc" }),
  "an ok response with content is usable",
);
equal(isUsableKugouDownload({ status: 403, content: "abc" }), false, "a 403 body is a miss");
equal(isUsableKugouDownload({ status: 200, content: "" }), false, "empty content is a miss");
equal(isUsableKugouDownload({ status: 200 }), false, "missing content is a miss");

const lrc = "﻿[00:01.00]Hello\r\n[00:02.00]World\r\n";
const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(lrc)));
const decoded = decodeKugouLrc(encoded);
check(decoded.startsWith("[00:01.00]Hello"), "the UTF-8 BOM is stripped");
check(decoded.includes("[00:02.00]World"), "the CRLF lines survive");
equal(
  decodeKugouLrc(encoded.slice(0, 8) + "\n" + encoded.slice(8)),
  decoded,
  "base64 wrapped across lines is tolerated",
);

console.log("kugou self-check passed");
