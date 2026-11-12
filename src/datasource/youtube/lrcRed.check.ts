import type { LrcRedHit, LrcRedTarget } from "./lrcRed";

export {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const { pickLrcRedHit } = await import("./lrcRed");

function target(overrides: Partial<LrcRedTarget> = {}): LrcRedTarget {
  return {
    title: "Creep",
    artist: "Radiohead",
    album: "Pablo Honey",
    durationSec: 238.64,
    ...overrides,
  };
}

function hit(overrides: Partial<LrcRedHit> = {}): LrcRedHit {
  return {
    isrc: "GBAYE9200070",
    title: "Creep",
    artist: "Radiohead",
    album: "Pablo Honey",
    duration: 238.64,
    ...overrides,
  };
}

equal(pickLrcRedHit(target(), [hit()])?.isrc, "GBAYE9200070", "an exact hit is chosen");
equal(
  pickLrcRedHit(target(), [hit({ artist: "Mirko Barbesino" })]),
  undefined,
  "a cover by another artist is rejected",
);
equal(
  pickLrcRedHit(target(), [hit({ title: "Creep (Live)" })]),
  undefined,
  "a live version is rejected",
);
equal(
  pickLrcRedHit(target(), [hit({ title: "Creep (Acoustic)" })]),
  undefined,
  "an acoustic version is rejected",
);
equal(
  pickLrcRedHit(target(), [hit({ duration: 242 })]),
  undefined,
  "a hit more than two seconds away is rejected",
);
equal(
  pickLrcRedHit(target({ title: "演员", artist: "薛之谦", durationSec: 261.25 }), [
    hit({ isrc: "CNA651500230", title: "演员", artist: "薛之謙", duration: 261.25 }),
  ])?.isrc,
  "CNA651500230",
  "traditional and simplified credits still match",
);
equal(
  pickLrcRedHit(target({ title: "Creep (Official Video)" }), [hit()])?.isrc,
  "GBAYE9200070",
  "a video suffix on the YouTube title does not block the hit",
);
equal(
  pickLrcRedHit(target({ durationSec: undefined }), [hit()]),
  undefined,
  "a track with no duration cannot be matched",
);
equal(pickLrcRedHit(target(), []), undefined, "no hits is undefined, not a crash");

const human = hit({ isrc: "HUMAN" });
const model = hit({ isrc: "MODEL", byModel: true });
equal(
  pickLrcRedHit(target(), [model, human])?.isrc,
  "HUMAN",
  "a human-timed entry is preferred over a model one",
);
equal(
  pickLrcRedHit(target(), [model])?.isrc,
  "MODEL",
  "but a model entry is still used when it is the only hit",
);

equal(
  pickLrcRedHit(target(), [hit({ artist: "Someone, Radiohead" })])?.isrc,
  "GBAYE9200070",
  "a shared artist in a collaboration is enough",
);

console.log("lrcRed self-check passed");
