export {};

import {
  addonCompositeId,
  buildAddonSearchUrl,
  buildAddonStreamUrl,
  isAddonTrackId,
  normalizeAddonBaseUrl,
  redactedAddonUrl,
  sourceFingerprint,
} from "./url";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const base = normalizeAddonBaseUrl("https://host.example/abc123secret/manifest.json");
equal(base.baseUrl, "https://host.example/abc123secret", "manifest URL normalises to base");
equal(base.insecure, false, "https is secure");
equal(
  normalizeAddonBaseUrl("https://host.example/abc123secret/").baseUrl,
  "https://host.example/abc123secret",
  "trailing slash trimmed",
);
equal(
  normalizeAddonBaseUrl("https://host.example/abc123secret/MANIFEST.JSON").baseUrl,
  "https://host.example/abc123secret",
  ".json suffix is case-insensitive",
);
equal(normalizeAddonBaseUrl("http://localhost:8787/dev").insecure, true, "localhost http warned");
equal(normalizeAddonBaseUrl("http://192.168.1.5:8787/dev").insecure, true, "private literal http warned");

for (const bad of [
  "http://example.com/dev",
  "file:///tmp/addon",
  "data:application/json,{}",
  "ftp://host/dev",
  "https://user:pass@host/dev",
  "https://host/dev?token=x",
  "https://host/dev#frag",
]) {
  let threw = false;
  try {
    normalizeAddonBaseUrl(bad);
  } catch (error) {
    threw = true;
    check(
      !String((error as Error).message).includes("token=x"),
      `error does not echo the secret: ${bad}`,
    );
  }
  check(threw, `rejects ${bad}`);
}

equal(redactedAddonUrl("https://host.example/abc/manifest.json"), "https://host.example/***", "redacts path");
equal(redactedAddonUrl("http://localhost:8787/dev"), "http://localhost:8787/***", "keeps port when present");

const sourceId = "3f1c2a44-1111-4222-8333-444455556666";
const id = await addonCompositeId(sourceId, "tidal:479222720/../x?y");
check(/^addon\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}$/.test(id), "composite id has safe bounded shape");
check(!id.includes("/") && !id.includes(":") && !id.includes(".."), "composite id has no unsafe chars");
equal(await addonCompositeId(sourceId, "tidal:479222720/../x?y"), id, "composite id is stable");
check(id !== await addonCompositeId(sourceId, "other"), "different addon ids differ");
check(isAddonTrackId(id), "recognises addon id");
check(!isAddonTrackId("dQw4w9WgXcQ"), "does not claim youtube id");
check(
  await sourceFingerprint("https://host/a") !== await sourceFingerprint("https://host/b"),
  "base URL changes change the fingerprint",
);

const streamUrl = buildAddonStreamUrl("https://host.example/abc", "tidal:1/2?x", [["quality", "HIGH"]]);
check(streamUrl.startsWith("https://host.example/abc/stream/"), "stream path keeps base secret");
check(streamUrl.includes("tidal%3A1%2F2%3Fx"), "track id is percent-encoded as one path segment");
check(streamUrl.endsWith("?quality=HIGH"), "stream quality parameter appended");

const searchUrl = buildAddonSearchUrl("https://host.example/abc", "new jeans & more", [["quality", "LOW"]]);
check(searchUrl.includes("q=new+jeans+%26+more"), "search query is URL-encoded");
check(searchUrl.includes("quality=LOW"), "search quality parameter appended");

console.log("addon/url: ok");
