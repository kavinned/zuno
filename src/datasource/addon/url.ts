export class AddonUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddonUrlError";
  }
}

export interface NormalizedAddonBaseUrl {
  baseUrl: string;
  insecure: boolean;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

function isPrivateIpv6(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "::1"
    || normalized.startsWith("fe80:")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd");
}

function isAllowedHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (host.startsWith("[")) return isPrivateIpv6(host);
  const octets = parseIpv4(host);
  return octets !== null && isPrivateIpv4(octets);
}

/**
 * Whether an addon may point its media at this host.
 *
 * A public addon is untrusted input, so a resolve answer aimed at loopback or the LAN is
 * refused. A local addon is expected to serve its own media from localhost, so it keeps that
 * freedom — the base URL's own reachability is the trust signal.
 */
export function addonMediaHostAllowed(mediaUrl: string, baseUrl: string): boolean {
  let media: URL;
  let base: URL;
  try {
    media = new URL(mediaUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  return !isAllowedHttpHost(media.hostname) || isAllowedHttpHost(base.hostname);
}

export function normalizeAddonBaseUrl(input: string): NormalizedAddonBaseUrl {
  const trimmed = input.trim();
  if (!trimmed) throw new AddonUrlError("An addon URL is required.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AddonUrlError("Enter a valid http or https URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AddonUrlError("Addon URLs must use http or https.");
  }
  if (url.username || url.password) {
    throw new AddonUrlError("Addon URLs must not contain embedded credentials.");
  }
  if (url.search || url.hash) {
    throw new AddonUrlError("Addon URLs must not contain a query string or fragment.");
  }
  if (!url.hostname) throw new AddonUrlError("Addon URL has no host.");
  if (url.protocol === "http:" && !isAllowedHttpHost(url.hostname)) {
    throw new AddonUrlError("Plain http is only allowed for localhost or a private network address.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length > 0 && segments[segments.length - 1].toLowerCase().endsWith(".json")) {
    segments.pop();
  }
  const path = segments.length > 0 ? `/${segments.join("/")}` : "";

  return {
    baseUrl: `${url.protocol}//${url.host}${path}`,
    insecure: url.protocol === "http:",
  };
}

export function redactedAddonUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}/***`;
  } catch {
    return "<invalid addon URL>";
  }
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function addonCompositeId(sourceId: string, trackId: string): Promise<string> {
  const digest = await sha256Base64Url(trackId);
  return `addon.${sourceId}.${digest.slice(0, 22)}`;
}

export async function sourceFingerprint(baseUrl: string): Promise<string> {
  return sha256Base64Url(normalizeAddonBaseUrl(baseUrl).baseUrl);
}

export function isAddonTrackId(id: string): boolean {
  return /^addon\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{22}$/.test(id);
}

function addonEndpoint(baseUrl: string, suffix: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}${suffix}`);
}

function appendParams(url: URL, params: ReadonlyArray<readonly [string, string]>): void {
  for (const [key, value] of params) url.searchParams.set(key, value);
}

export function buildAddonSearchUrl(
  baseUrl: string,
  query: string,
  params: ReadonlyArray<readonly [string, string]> = [],
): string {
  const url = addonEndpoint(baseUrl, "/search");
  url.searchParams.set("q", query);
  appendParams(url, params.filter(([key]) => key !== "q"));
  return url.toString();
}

export function buildAddonStreamUrl(
  baseUrl: string,
  trackId: string,
  params: ReadonlyArray<readonly [string, string]> = [],
): string {
  const url = addonEndpoint(baseUrl, `/stream/${encodeURIComponent(trackId)}`);
  appendParams(url, params);
  return url.toString();
}
