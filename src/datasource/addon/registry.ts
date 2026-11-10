import {
  appSettingsAddonStorage,
  keyringAddonSecrets,
  type AddonRegistryStorage,
  type AddonSecretStore,
} from "./storage";
import type {
  AddonHealth,
  AddonManifest,
  AddonSourceConfig,
  PersistedAddonSource,
} from "./types";
import { normalizeAddonBaseUrl } from "./url";

export interface AddonRegistryState {
  sources: AddonSourceConfig[];
  loaded: boolean;
}

export type AddonSourcePatch = Partial<
  Pick<AddonSourceConfig, "label" | "enabled" | "order" | "allowDownloads" | "checkValidLossless">
> & { baseUrl?: string };

/** The base URL lives in the keyring, so it is stripped on every write. */
function toPersisted(source: AddonSourceConfig): PersistedAddonSource {
  const persisted = { ...source };
  delete (persisted as Partial<AddonSourceConfig>).baseUrl;
  return persisted;
}

function byOrder(a: AddonSourceConfig, b: AddonSourceConfig): number {
  return a.order - b.order;
}

export class AddonRegistry {
  private readonly storage: AddonRegistryStorage;
  private readonly secrets: AddonSecretStore;
  private readonly listeners = new Set<() => void>();
  private state: AddonRegistryState = { sources: [], loaded: false };
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    storage: AddonRegistryStorage = appSettingsAddonStorage,
    secrets: AddonSecretStore = keyringAddonSecrets,
  ) {
    this.storage = storage;
    this.secrets = secrets;
  }

  getState = (): AddonRegistryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  ensureLoaded = (): Promise<void> => {
    if (this.state.loaded) return Promise.resolve();
    this.loading ??= this.hydrate();
    return this.loading;
  };

  get(id: string): AddonSourceConfig | undefined {
    return this.state.sources.find((source) => source.id === id);
  }

  list(): AddonSourceConfig[] {
    return [...this.state.sources];
  }

  add(label: string, rawUrl: string): Promise<AddonSourceConfig> {
    return this.mutate(async () => {
      const { baseUrl } = normalizeAddonBaseUrl(rawUrl);
      const id = crypto.randomUUID();
      await this.secrets.set(id, baseUrl);
      const order = this.state.sources.reduce(
        (next, source) => Math.max(next, source.order + 1),
        0,
      );
      const source: AddonSourceConfig = {
        id,
        label: label.trim(),
        baseUrl,
        enabled: true,
        order,
        allowDownloads: true,
        checkValidLossless: false,
      };
      const sources = [...this.state.sources, source];
      await this.commit(sources);
      return source;
    });
  }

  update(id: string, patch: AddonSourcePatch): Promise<AddonSourceConfig> {
    return this.mutate(async () => {
      const current = this.require(id);
      let baseUrl = current.baseUrl;
      let urlChanged = false;
      if (patch.baseUrl !== undefined) {
        const normalized = normalizeAddonBaseUrl(patch.baseUrl).baseUrl;
        if (normalized !== current.baseUrl) {
          baseUrl = normalized;
          urlChanged = true;
          await this.secrets.set(id, baseUrl);
        }
      }
      let next: AddonSourceConfig = {
        ...current,
        baseUrl,
        label: patch.label ?? current.label,
        enabled: patch.enabled ?? current.enabled,
        order: patch.order ?? current.order,
        allowDownloads: patch.allowDownloads ?? current.allowDownloads,
        checkValidLossless: patch.checkValidLossless ?? current.checkValidLossless,
      };
      if (urlChanged) {
        next = {
          ...next,
          allowDownloads: true,
          checkValidLossless: false,
          manifestName: undefined,
          manifestVersion: undefined,
          lastManifestAt: undefined,
          lastHealth: undefined,
        };
      }
      const sources = this.state.sources.map((source) => (source.id === id ? next : source));
      await this.commit(sources);
      return next;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      await this.secrets.delete(id);
      const sources = this.state.sources.filter((source) => source.id !== id);
      await this.commit(sources);
    });
  }

  reorder(ids: string[]): Promise<void> {
    return this.mutate(async () => {
      const positions = new Map(ids.map((id, index) => [id, index]));
      const sources = this.state.sources.map((source) => {
        const order = positions.get(source.id);
        return order === undefined ? source : { ...source, order };
      });
      await this.commit(sources);
    });
  }

  recordProbe(
    id: string,
    health: AddonHealth,
    manifest: AddonManifest | null = null,
  ): Promise<void> {
    return this.mutate(async () => {
      const current = this.require(id);
      const next: AddonSourceConfig = { ...current, lastHealth: health };
      if (manifest !== null) {
        next.manifestName = manifest.name;
        next.manifestVersion = manifest.version;
        next.allowDownloads = manifest.allowDownloads;
        next.checkValidLossless = manifest.checkValidLossless;
        next.lastManifestAt = Date.now();
      }
      const sources = this.state.sources.map((source) => (source.id === id ? next : source));
      await this.commit(sources);
    });
  }

  private require(id: string): AddonSourceConfig {
    const source = this.state.sources.find((entry) => entry.id === id);
    if (!source) throw new Error("That addon source no longer exists.");
    return source;
  }

  private async hydrate(): Promise<void> {
    const persisted = await this.storage.read();
    const sources: AddonSourceConfig[] = [];
    for (const config of persisted) {
      const baseUrl = await this.secrets.get(config.id);
      sources.push(baseUrl === null
        ? { ...config, baseUrl: "", lastHealth: "rejected" }
        : { ...config, baseUrl });
    }
    this.setState(sources);
  }

  private async commit(sources: AddonSourceConfig[]): Promise<void> {
    sources.sort(byOrder);
    await this.storage.write(sources.map(toPersisted));
    this.setState(sources);
  }

  /** Hydration only reads; a load must not rewrite settings. */
  private setState(sources: AddonSourceConfig[]): void {
    sources.sort(byOrder);
    this.state = { sources, loaded: true };
    for (const listener of this.listeners) listener();
  }

  /** Rapid edits queue behind each other so a later write cannot clobber an earlier one. */
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureLoaded();
      return work();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
