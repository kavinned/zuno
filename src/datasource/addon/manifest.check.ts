export {};
import {
  addonQualityParams,
  parseBooleanLike,
  parseManifest,
  parseSearchResponse,
  parseStreamAnswer,
} from "./manifest";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

for (const value of [true, 1, "1", "yes", "on", 7]) equal(parseBooleanLike(value), true, `true-like ${value}`);
for (const value of [false, 0, "0", "no", "off"]) equal(parseBooleanLike(value), false, `false-like ${value}`);
for (const value of [null, undefined, "", "maybe", {}]) equal(parseBooleanLike(value), undefined, `absent ${String(value)}`);

const manifest = parseManifest({
  id: "torbox",
  name: "TorBox",
  version: "1.1.0",
  resources: ["SEARCH", "stream"],
  settings: [{ key: "quality", default: "lossless", options: [{ value: "lossless" }, { value: "high" }] }],
  allowDownloads: 0,
});
equal(manifest.id, "torbox", "id parsed");
equal(manifest.allowDownloads, false, "allowDownloads 0 is false");
equal(manifest.checkValidLossless, false, "checkValidLossless defaults false");
equal(manifest.resources[0], "SEARCH", "resources preserved");

equal(parseManifest({ id: "x" }).allowDownloads, true, "absent allowDownloads means allowed");
equal(parseManifest({ id: "x", resources: [] }).id, "x", "empty resources is silence, not refusal");

for (const bad of [
  {},
  { id: "" },
  { id: "x", resources: ["stream"] },
]) {
  let threw = false;
  try { parseManifest(bad); } catch { threw = true; }
  check(threw, `rejects manifest ${JSON.stringify(bad)}`);
}
let noSearchKind = "";
try { parseManifest({ id: "x", resources: ["stream"] }); } catch (error) {
  noSearchKind = (error as { kind?: string }).kind ?? "";
}
equal(noSearchKind, "no-search", "resources without search is a rejection, not a missing manifest");

check(parseSearchResponse({}).length === 0, "missing tracks yields none");
const answer = parseStreamAnswer({ url: "https://cdn/a", format: "flac", encrypted: false, bitDepth: 24 });
check(answer.url === "https://cdn/a" && answer.format === "flac", "stream answer fields preserved");
const rows = parseSearchResponse({
  tracks: [
    { id: "tidal:1", title: "Gehra Hua", artist: "Arijit Singh", duration: 362, artworkURL: "https://cdn/a.jpg", streamURL: "https://cdn/s" },
    { id: "", title: "dropped" },
    { id: "x", title: "" },
  ],
});
equal(rows.length, 1, "blank id/title rows dropped");
equal(rows[0].durationSec, 362, "duration mapped");
equal(rows[0].artworkUrl, "https://cdn/a.jpg", "artworkURL mapped");
equal(rows[0].streamUrl, "https://cdn/s", "streamURL mapped");
equal(parseSearchResponse({ tracks: [{ id: "x", title: "t", duration: 0 }] })[0].durationSec, undefined, "zero duration absent");

const quality = parseManifest({ id: "x", settings: [{ key: "quality", default: "lossless", options: [{ value: "lossless" }, { value: "high" }, { value: "low" }] }] });
equal(JSON.stringify(addonQualityParams(quality, "high")), JSON.stringify([["quality", "high"]]), "exact option match wins");
equal(JSON.stringify(addonQualityParams(quality, "normal")), JSON.stringify([["quality", "high"]]), "normal maps to HIGH");
equal(JSON.stringify(addonQualityParams(quality, "low")), JSON.stringify([["quality", "low"]]), "low maps to LOW");
equal(JSON.stringify(addonQualityParams(null, "normal")), JSON.stringify([["quality", "HIGH"]]), "no manifest sends tier verbatim");

const defaults = parseManifest({
  id: "x",
  settings: [
    { key: "quality", default: "lossless", options: [{ value: "flac" }, { value: "mp3" }] },
    { key: "region", default: "us" },
  ],
});
equal(JSON.stringify(addonQualityParams(defaults, "high")), JSON.stringify([["quality", "flac"], ["region", "us"]]), "unknown tier falls back to first option and preserves other defaults");
check(!JSON.stringify(addonQualityParams(defaults, "high")).includes("atmos"), "atmos never sent");

console.log("addon/manifest: ok");
