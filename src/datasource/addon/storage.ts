import { getAppSetting, setAppSetting } from "../../internal/appSettings";
import { deleteAddonSecret, getAddonSecret, setAddonSecret } from "./transport";
import type { PersistedAddonSource } from "./types";

export const ADDON_SOURCES_KEY = "zuno.addon-sources.v1";
const STORAGE_VERSION = 1;

export interface AddonRegistryStorage {
  read(): Promise<PersistedAddonSource[]>;
  write(sources: PersistedAddonSource[]): Promise<void>;
}

export interface AddonSecretStore {
  get(sourceId: string): Promise<string | null>;
  set(sourceId: string, value: string): Promise<void>;
  delete(sourceId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedAddonSource(value: unknown): value is PersistedAddonSource {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.label === "string"
    && typeof value.enabled === "boolean"
    && typeof value.order === "number"
    && typeof value.allowDownloads === "boolean"
    && typeof value.checkValidLossless === "boolean";
}

/**
 * Validates the stored envelope. A corrupt object reads as empty; a readable envelope from
 * an unknown version is refused rather than silently dropped, since that would lose sources.
 */
export function parseAddonSources(value: unknown): PersistedAddonSource[] {
  if (!isRecord(value)) return [];
  if (value.version !== STORAGE_VERSION) {
    throw new Error(`Unsupported addon sources version: ${String(value.version)}`);
  }
  if (!Array.isArray(value.sources)) return [];
  return value.sources.filter(isPersistedAddonSource);
}

export const appSettingsAddonStorage: AddonRegistryStorage = {
  read: async () => parseAddonSources(await getAppSetting<unknown>(ADDON_SOURCES_KEY)),
  write: async (sources) => {
    await setAppSetting(ADDON_SOURCES_KEY, { version: STORAGE_VERSION, sources });
  },
};

export const keyringAddonSecrets: AddonSecretStore = {
  get: (sourceId) => getAddonSecret(sourceId),
  set: (sourceId, value) => setAddonSecret(sourceId, value),
  delete: (sourceId) => deleteAddonSecret(sourceId),
};
