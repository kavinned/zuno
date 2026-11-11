export {};

import { AddonRegistry } from "./registry";
import {
  parseAddonSources,
  type AddonRegistryStorage,
  type AddonSecretStore,
} from "./storage";
import type { AddonManifest, PersistedAddonSource } from "./types";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

class MemoryStorage implements AddonRegistryStorage {
  readonly writes: PersistedAddonSource[][] = [];
  reads = 0;
  failReads = 0;
  private raw: unknown;

  constructor(raw: unknown = null) {
    this.raw = raw;
  }

  async read(): Promise<PersistedAddonSource[]> {
    this.reads += 1;
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error("storage unavailable");
    }
    return parseAddonSources(this.raw);
  }

  async write(sources: PersistedAddonSource[]): Promise<void> {
    this.writes.push(sources);
    this.raw = { version: 1, sources };
  }
}

class MemorySecrets implements AddonSecretStore {
  private readonly values = new Map<string, string>();

  async get(sourceId: string): Promise<string | null> {
    return this.values.get(sourceId) ?? null;
  }

  async set(sourceId: string, value: string): Promise<void> {
    this.values.set(sourceId, value);
  }

  async delete(sourceId: string): Promise<void> {
    this.values.delete(sourceId);
  }
}

function persisted(overrides: Partial<PersistedAddonSource> = {}): PersistedAddonSource {
  return {
    id: "seed",
    label: "Seed",
    enabled: true,
    order: 0,
    allowDownloads: true,
    checkValidLossless: false,
    ...overrides,
  };
}

function lastWrite(storage: MemoryStorage): PersistedAddonSource[] {
  return storage.writes[storage.writes.length - 1] ?? [];
}

const seedStorage = new MemoryStorage({
  version: 1,
  sources: [
    persisted({ id: "second", label: "Second", order: 2 }),
    persisted({ id: "first", label: "First", order: 1 }),
  ],
});
const seedSecrets = new MemorySecrets();
await seedSecrets.set("first", "https://first.example/secret");

const hydrated = new AddonRegistry(seedStorage, seedSecrets);
await hydrated.ensureLoaded();
equal(hydrated.list().map((source) => source.id).join(","), "first,second", "sources load in order");
equal(hydrated.list()[0].baseUrl, "https://first.example/secret", "base URL comes from the secret store");
equal(hydrated.list()[1].baseUrl, "", "missing secret leaves no base URL");
equal(hydrated.list()[1].lastHealth, "rejected", "missing secret marks the source rejected");
check(hydrated.getState().loaded, "state reports loaded");
equal(hydrated.get("first")?.label, "First", "get finds a source");
equal(hydrated.get("missing"), undefined, "get returns undefined for an unknown source");
await hydrated.ensureLoaded();
equal(seedStorage.reads, 1, "ensureLoaded reads once");
equal(seedStorage.writes.length, 0, "loading does not rewrite settings");

const corruptStorage = new MemoryStorage({ version: 1, sources: "not-an-array" });
const corrupt = new AddonRegistry(corruptStorage, new MemorySecrets());
await corrupt.ensureLoaded();
equal(corrupt.list().length, 0, "corrupt sources read as an empty registry");
equal(parseAddonSources("garbage").length, 0, "non-object persisted data reads as empty");

let versionRefused = false;
try {
  await new AddonRegistry(
    new MemoryStorage({ version: 2, sources: [] }),
    new MemorySecrets(),
  ).ensureLoaded();
} catch {
  versionRefused = true;
}
check(versionRefused, "an unknown persisted version is refused");

const storage = new MemoryStorage();
const secrets = new MemorySecrets();
const registry = new AddonRegistry(storage, secrets);
await registry.ensureLoaded();

const source = await registry.add("TorBox", "https://host.example/abc123secret/manifest.json");
check(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(source.id),
  "add generates a UUID",
);
equal(source.baseUrl, "https://host.example/abc123secret", "add normalizes the base URL");
equal(source.order, 0, "the first source starts at order 0");
equal(source.enabled, true, "a new source is enabled");
equal(source.allowDownloads, true, "downloads are allowed by default");
equal(source.checkValidLossless, false, "the lossless check is off by default");
equal(registry.list().length, 1, "a new source enters the state");
equal(await secrets.get(source.id), "https://host.example/abc123secret", "base URL stored in the secret store");

const written = JSON.stringify(lastWrite(storage));
check(!written.includes("abc123secret"), "base URL never persisted");
check(!written.includes("baseUrl"), "baseUrl field never persisted");

const second = await registry.add("Second", "https://other.example/token");
equal(second.order, 1, "sources append at the end");

const manifest: AddonManifest = {
  id: "torbox",
  name: "TorBox Pro",
  version: "2.0.0",
  resources: ["search"],
  settings: [],
  allowDownloads: false,
  checkValidLossless: true,
};
await registry.recordProbe(source.id, "ok", manifest);
const probed = registry.get(source.id);
equal(probed?.manifestName, "TorBox Pro", "probe copies the manifest name");
equal(probed?.manifestVersion, "2.0.0", "probe copies the manifest version");
equal(probed?.allowDownloads, false, "probe copies allowDownloads");
equal(probed?.checkValidLossless, true, "probe copies checkValidLossless");
equal(probed?.lastHealth, "ok", "probe stores health");
check(typeof probed?.lastManifestAt === "number", "probe records when the manifest arrived");
check(!JSON.stringify(lastWrite(storage)).includes("abc123secret"), "probe write keeps the secret out");

await registry.update(source.id, {
  baseUrl: "https://host.example/newsecret/manifest.json",
  label: "Edited",
});
const updated = registry.get(source.id);
equal(updated?.baseUrl, "https://host.example/newsecret", "update normalizes and applies the new URL");
equal(await secrets.get(source.id), "https://host.example/newsecret", "update replaces the secret");
equal(updated?.label, "Edited", "update applies the label");
equal(updated?.allowDownloads, true, "update resets allowDownloads");
equal(updated?.checkValidLossless, false, "update resets checkValidLossless");
equal(updated?.manifestName, undefined, "update clears the manifest name");
equal(updated?.manifestVersion, undefined, "update clears the manifest version");
equal(updated?.lastManifestAt, undefined, "update clears lastManifestAt");
equal(updated?.lastHealth, undefined, "update clears health");
const updatedWrite = JSON.stringify(lastWrite(storage));
check(!updatedWrite.includes("newsecret"), "the new secret is never persisted");

/* A probe that resolved against the old URL must not stamp the just-edited source. */
await registry.recordProbe(source.id, "unreachable", null, "https://host.example/oldsecret");
equal(registry.get(source.id)?.lastHealth, undefined, "a stale probe from the old URL is ignored");
await registry.recordProbe(source.id, "ok", null, "https://host.example/newsecret");
equal(registry.get(source.id)?.lastHealth, "ok", "a probe from the current URL still writes");

const restrictive: AddonManifest = {
  id: "torbox",
  resources: ["search"],
  settings: [],
  allowDownloads: false,
  checkValidLossless: true,
};
await registry.recordProbe(second.id, "ok", restrictive);
equal(registry.get(second.id)?.allowDownloads, false, "a manifest probe applies allowDownloads");
equal(registry.get(second.id)?.checkValidLossless, true, "a manifest probe applies checkValidLossless");

await registry.recordProbe(second.id, "unreachable", null);
const untouched = registry.get(second.id);
equal(untouched?.allowDownloads, true, "an absent manifest restores the allowDownloads default");
equal(untouched?.checkValidLossless, false, "an absent manifest restores the checkValidLossless default");
equal(untouched?.manifestName, undefined, "an absent manifest leaves no manifest name");
equal(untouched?.lastHealth, "unreachable", "an absent manifest still records health");

await registry.reorder([second.id, source.id]);
equal(
  registry.list().map((entry) => entry.id).join(","),
  `${second.id},${source.id}`,
  "reorder rewrites the list order",
);
equal(registry.get(second.id)?.order, 0, "reorder sets the first source to order 0");
equal(registry.get(source.id)?.order, 1, "reorder sets the second source to order 1");
equal(
  lastWrite(storage).map((entry) => entry.order).join(","),
  "0,1",
  "reorder persists the new order",
);

await registry.remove(second.id);
equal(await secrets.get(second.id), null, "remove deletes the secret");
equal(registry.get(second.id), undefined, "remove drops the config");
check(!JSON.stringify(lastWrite(storage)).includes(second.id), "remove persists without the source");
equal(registry.list().length, 1, "remove leaves the other source");

await registry.ensureLoaded();
equal(storage.reads, 1, "later ensureLoaded calls do not read again");

for (const write of storage.writes) {
  const serialized = JSON.stringify(write);
  check(!serialized.includes("baseUrl"), "no write ever persists baseUrl");
  check(!serialized.includes("host.example"), "no write ever persists a base URL path");
  check(!serialized.includes("other.example"), "no write ever persists a base URL host");
}

const flakyStorage = new MemoryStorage({ version: 1, sources: [persisted()] });
flakyStorage.failReads = 1;
const flaky = new AddonRegistry(flakyStorage, new MemorySecrets());
let hydrateRejected = false;
try {
  await flaky.ensureLoaded();
} catch {
  hydrateRejected = true;
}
check(hydrateRejected, "a failed hydrate stays visible to the caller");
equal(flaky.getState().loaded, false, "a failed hydrate leaves the registry unloaded");
await flaky.ensureLoaded();
check(flaky.getState().loaded, "a later ensureLoaded retries after a failed hydrate");
equal(flaky.list().length, 1, "the retry loads the persisted sources");
equal(flakyStorage.reads, 2, "the retry reads storage again");

console.log("addon/registry: ok");
