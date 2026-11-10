export {};

import { formatAddonAudioInfo } from "./audioInfoText";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`FAILED: ${message}: expected "${String(expected)}", got "${String(actual)}"`);
  }
}

equal(
  formatAddonAudioInfo({ sampleRateHz: 44_100, bitDepth: 16, kbps: 1411 }),
  "44.1 kHz · 16-bit · 1411 kbps",
  "all three fields",
);
equal(
  formatAddonAudioInfo({ sampleRateHz: 48_000, bitDepth: 24 }),
  "48 kHz · 24-bit",
  "integer kilohertz omits the fraction",
);
equal(formatAddonAudioInfo({ kbps: 900 }), "900 kbps", "bitrate alone");
equal(formatAddonAudioInfo({}), "", "no fields renders nothing");

console.log("ui/player/audioInfoText: ok");
