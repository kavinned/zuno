import { AddonClient, AddonRequestError } from "./client";
import type { AddonRequest, AddonRequestResult } from "./transport";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const source = {
  id: "6f1f0f1e-0000-4000-8000-000000000000",
  label: "Test addon",
  baseUrl: "https://addon.example/music",
  enabled: true,
  order: 0,
  allowDownloads: true,
  checkValidLossless: false,
};

type Responder = (url: string) => AddonRequestResult | Promise<AddonRequestResult>;

function fakeTransport(responder: Responder): { request: AddonRequest; urls: string[] } {
  const urls: string[] = [];
  const request: AddonRequest = (input) => {
    urls.push(input.url);
    return Promise.resolve().then(() => responder(input.url));
  };
  return { request, urls };
}

function sequence(...responses: Array<AddonRequestResult | Error>): Responder {
  let index = 0;
  return () => {
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (response instanceof Error) throw response;
    return response;
  };
}

async function expectKind(promise: Promise<unknown>, kind: string, message: string): Promise<AddonRequestError> {
  try {
    await promise;
  } catch (error) {
    check(error instanceof AddonRequestError, `${message}: threw ${String(error)} instead of AddonRequestError`);
    equal((error as AddonRequestError).kind, kind, message);
    return error as AddonRequestError;
  }
  throw new Error(`FAILED: ${message}: did not throw`);
}

const tracksBody = JSON.stringify({ tracks: [{ id: "tidal:1", title: "Gehra Hua", duration: 362 }] });
const noSleep = async (): Promise<void> => {};

{
  const slept: number[] = [];
  const transport = fakeTransport(sequence({ status: 429, body: "", retryAfter: "2" }, { status: 200, body: tracksBody }));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 0,
  });
  const rows = await client.search("gehra", "high");
  equal(rows.length, 1, "429 retry: rows parsed");
  equal(rows[0].title, "Gehra Hua", "429 retry: title mapped");
  equal(transport.urls.length, 2, "429 retry: one retry");
  equal(slept.length, 1, "429 retry: one sleep");
  equal(slept[0], 2000, "Retry-After honoured");
  equal(
    transport.urls[0],
    "https://addon.example/music/search?q=gehra&quality=HIGH",
    "429 retry: search URL built from the base URL and quality params",
  );
}

{
  const slept: number[] = [];
  const transport = fakeTransport(sequence(
    { status: 429, body: "" },
    { status: 429, body: "" },
    { status: 200, body: tracksBody },
  ));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 0,
  });
  await client.search("gehra", "high");
  equal(JSON.stringify(slept), JSON.stringify([500, 2000]), "missing Retry-After backs off 500 then 2000");
  equal(transport.urls.length, 3, "missing Retry-After: two retries");
}

{
  const slept: number[] = [];
  const transport = fakeTransport(sequence({ status: 429, body: "", retryAfter: "120" }, { status: 200, body: tracksBody }));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 0,
  });
  await client.search("gehra", "high");
  equal(slept[0], 8000, "Retry-After capped at 8000 ms");
}

{
  const transport = fakeTransport(() => ({ status: 429, body: "" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  const error = await expectKind(client.search("gehra", "high"), "rate-limited", "429 exhaustion");
  equal(error.status, 429, "429 exhaustion keeps the status");
  equal(transport.urls.length, 3, "at most three attempts");
  check(client.isRateLimited(), "client reports the quiet period");
  check(!error.message.includes("addon.example"), "429 error carries no URL");
}

{
  const slept: number[] = [];
  const transport = fakeTransport(sequence({ status: 503, body: "", retryAfter: "2" }, { status: 200, body: tracksBody }));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 0,
  });
  const rows = await client.search("gehra", "high");
  equal(rows.length, 1, "503 Retry-After: search succeeds after the retry");
  equal(transport.urls.length, 2, "503 Retry-After: one retry");
  equal(JSON.stringify(slept), JSON.stringify([2000]), "503 honours Retry-After");
}

{
  const slept: number[] = [];
  const transport = fakeTransport(sequence({ status: 503, body: "", retryAfter: "30" }, { status: 200, body: tracksBody }));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 0,
  });
  await client.search("gehra", "high");
  equal(JSON.stringify(slept), JSON.stringify([8000]), "503 Retry-After capped at 8000 ms");
}

{
  const slept: number[] = [];
  const transport = fakeTransport(sequence(
    { status: 503, body: "" },
    { status: 503, body: "" },
    { status: 200, body: tracksBody },
  ));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 0,
  });
  await client.search("gehra", "high");
  equal(JSON.stringify(slept), JSON.stringify([500, 2000]), "503 without Retry-After backs off 500 then 2000");
  equal(transport.urls.length, 3, "503 without Retry-After: two retries");
}

{
  const transport = fakeTransport(() => ({ status: 503, body: "" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.search("gehra", "high"), "server", "5xx exhaustion");
  equal(transport.urls.length, 3, "5xx retried twice, then stops");
}

{
  const transport = fakeTransport(() => {
    throw new Error("addon request failed: connection refused");
  });
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.search("gehra", "high"), "unreachable", "network failure exhaustion");
  equal(transport.urls.length, 3, "network failure retried twice, then stops");
}

{
  const transport = fakeTransport(() => {
    throw new Error("addon request failed: operation timed out");
  });
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.search("gehra", "high"), "timeout", "timeout classified separately");
}

{
  const transport = fakeTransport(() => ({ status: 404, body: "" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  const error = await expectKind(client.resolveStream("tidal:1/2", "high"), "miss", "404 stream is a miss");
  equal(transport.urls.length, 1, "404 stream is not retried");
  equal(
    transport.urls[0],
    "https://addon.example/music/stream/tidal%3A1%2F2?quality=HIGH",
    "stream URL escapes the track id",
  );
  check(!error.message.includes("addon.example"), "miss error carries no URL");
}

{
  let clock = 0;
  const transport = fakeTransport(() => ({
    status: 200,
    body: JSON.stringify({ url: "https://cdn.example/a.flac", format: "flac" }),
  }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => clock });
  const answer = await client.resolveStream("tidal:1", "high");
  equal(answer.url, "https://cdn.example/a.flac", "stream answer returned");
  equal(answer.format, "flac", "stream answer fields preserved");
  await client.resolveStream("tidal:1", "high");
  equal(transport.urls.length, 1, "stream cached for five minutes");
  clock = 5 * 60_000 + 1;
  await client.resolveStream("tidal:1", "high");
  equal(transport.urls.length, 2, "stream cache expires after five minutes");
}

{
  let clock = 1_767_225_600_000;
  const transport = fakeTransport(() => ({
    status: 200,
    body: JSON.stringify({ url: "https://cdn.example/a.flac", expiresAt: clock + 120_000 }),
  }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => clock });
  await client.resolveStream("tidal:1", "high");
  clock += 59_000;
  await client.resolveStream("tidal:1", "high");
  equal(transport.urls.length, 1, "expiresAt margin still cached before the cutoff");
  clock += 2_000;
  await client.resolveStream("tidal:1", "high");
  equal(transport.urls.length, 2, "expiresAt margin shrinks the stream TTL");
}

for (const body of [JSON.stringify({ error: "unavailable" }), "{}", JSON.stringify({ url: "   " })]) {
  const transport = fakeTransport(() => ({ status: 200, body }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.resolveStream("tidal:1", "high"), "miss", `200 without a usable URL is a miss: ${body}`);
  equal(transport.urls.length, 1, "stream miss is not retried");
}

{
  const transport = fakeTransport(() => ({ status: 503, body: "" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.resolveStream("tidal:1", "high"), "server", "stream 5xx");
  equal(transport.urls.length, 3, "stream 5xx retried twice");
}

{
  const transport = fakeTransport(() => ({
    status: 200,
    body: JSON.stringify({ id: "torbox", name: "TorBox", version: "1.0.0", resources: ["search"] }),
  }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  const manifest = await client.getManifest();
  check(manifest !== null, "manifest parsed");
  equal(manifest?.id, "torbox", "manifest id");
  equal(transport.urls[0], "https://addon.example/music/manifest.json", "manifest URL");
  await client.getManifest();
  equal(transport.urls.length, 1, "manifest cached");
}

{
  const transport = fakeTransport(() => ({ status: 200, body: JSON.stringify({ id: "x", resources: ["stream"] }) }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.getManifest(), "rejected", "manifest without search is rejected");
  equal(transport.urls.length, 1, "manifest rejection is not retried");
}

{
  const transport = fakeTransport(() => ({ status: 200, body: JSON.stringify({ resources: ["search"] }) }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.getManifest(), "rejected", "manifest without id is rejected");
}

{
  const transport = fakeTransport(() => ({ status: 404, body: "" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  equal(await client.getManifest(), null, "404 manifest is null");
  equal(transport.urls.length, 1, "404 manifest is not retried");
}

{
  const transport = fakeTransport(() => ({ status: 200, body: "<html>not json</html>" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  equal(await client.getManifest(), null, "malformed manifest JSON is null");
  equal(transport.urls.length, 1, "malformed manifest is not retried");
}

{
  const transport = fakeTransport(() => ({ status: 404, body: "" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.search("gehra", "high"), "rejected", "search 404 is rejected");
  equal(transport.urls.length, 1, "search 404 is not retried");
}

{
  const transport = fakeTransport(() => ({ status: 200, body: "<html>not json</html>" }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.search("gehra", "high"), "rejected", "malformed search JSON is rejected");
}

{
  let calls = 0;
  let resolveRequest: ((response: AddonRequestResult) => void) | null = null;
  const client = new AddonClient(source, {
    request: () => {
      calls += 1;
      return new Promise<AddonRequestResult>((resolve) => { resolveRequest = resolve; });
    },
    sleep: noSleep,
    now: () => 0,
  });
  const first = client.search("same", "high");
  const second = client.search("same", "high");
  equal(calls, 1, "concurrent identical searches share one transport call");
  check(resolveRequest !== null, "transport received the request");
  resolveRequest!({ status: 200, body: tracksBody });
  const [left, right] = await Promise.all([first, second]);
  check(left === right, "concurrent searches share the same result");
  equal(left.length, 1, "shared search result parsed");
}

{
  let calls = 0;
  const transport = fakeTransport(() => {
    calls += 1;
    return { status: 200, body: tracksBody };
  });
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await client.search("cache me", "high");
  await client.search("cache me", "high");
  equal(calls, 1, "cache hit makes no second request");
  await client.search("cache me", "high", { bypassCache: true });
  equal(calls, 2, "bypassCache causes one request");
  await client.search("cache me", "high");
  equal(calls, 2, "bypassCache result is written to the cache");
  await client.search("other query", "high");
  equal(calls, 3, "search cache is keyed by query");
  client.invalidate();
  await client.search("cache me", "high");
  equal(calls, 4, "invalidate clears the cache");
}

{
  let clock = 0;
  const transport = fakeTransport(sequence(
    { status: 429, body: "", retryAfter: "5" },
    { status: 429, body: "", retryAfter: "5" },
    { status: 429, body: "", retryAfter: "5" },
    { status: 200, body: tracksBody },
  ));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => clock });
  await expectKind(client.search("first", "high"), "rate-limited", "quiet period starts after 429");
  equal(transport.urls.length, 3, "quiet period starts after three attempts");
  check(client.isRateLimited(), "isRateLimited is true during the quiet period");
  await expectKind(client.search("second", "high"), "rate-limited", "quiet period blocks a second search");
  equal(transport.urls.length, 3, "quiet period makes no request");
  clock += 5_000;
  check(!client.isRateLimited(), "quiet period ends after the Retry-After delay");
  const rows = await client.search("third", "high");
  equal(rows.length, 1, "search works after the quiet period");
  equal(transport.urls.length, 4, "one request after the quiet period");
}

{
  const controller = new AbortController();
  controller.abort();
  const transport = fakeTransport(() => ({ status: 200, body: tracksBody }));
  const client = new AddonClient(source, { request: transport.request, sleep: noSleep, now: () => 0 });
  await expectKind(client.search("gehra", "high", { signal: controller.signal }), "cancelled", "aborted before any request");
  equal(transport.urls.length, 0, "already-aborted signal makes no request");
}

{
  const controller = new AbortController();
  const transport = fakeTransport(() => ({ status: 429, body: "" }));
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: async () => { controller.abort(); },
    now: () => 0,
  });
  await expectKind(
    client.search("gehra", "high", { signal: controller.signal }),
    "cancelled",
    "abort during the retry sleep",
  );
  equal(transport.urls.length, 1, "abort after a sleep stops before the next request");
}

{
  /*
   * Two callers share one search. The first caller's budget expiring must not lose the search
   * for the second; the request itself runs to completion and caches.
   */
  let release: (() => void) | undefined;
  const transport = fakeTransport(
    () => new Promise<AddonRequestResult>((resolve) => {
      release = () => resolve({ status: 200, body: tracksBody });
    }),
  );
  const client = new AddonClient(source, {
    request: transport.request,
    sleep: noSleep,
    now: () => 0,
  });
  const controller = new AbortController();
  const first = client.search("gehra", "high", { signal: controller.signal });
  const second = client.search("gehra", "high");
  controller.abort();
  await expectKind(first, "cancelled", "the aborted caller observes cancellation");
  await Promise.resolve();
  release?.();
  const rows = await second;
  equal(rows.length, 1, "the second caller still gets the shared search");
  equal(transport.urls.length, 1, "the shared search was requested once");
}

console.log("addon/client: ok");
