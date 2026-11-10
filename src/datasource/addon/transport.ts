import { invoke } from "@tauri-apps/api/core";

export interface AddonRequestResult {
  status: number;
  body: string;
  contentType?: string;
  retryAfter?: string;
}

export type AddonRequest = (input: {
  url: string;
  timeoutMs?: number;
}) => Promise<AddonRequestResult>;

export interface AddonLengthProbe {
  contentLength?: number;
  contentType?: string;
  acceptsRanges: boolean;
  sampleRateHz?: number;
  bitDepth?: number;
}

export const tauriAddonRequest: AddonRequest = (input) =>
  invoke("addon_http_request", { input });

export const probeAddonLength = (
  url: string,
  sniffFlac = false,
): Promise<AddonLengthProbe> =>
  invoke("addon_probe_length", { url, sniffFlac });

export const getAddonSecret = (sourceId: string): Promise<string | null> =>
  invoke("addon_secret_get", { sourceId });

export const setAddonSecret = (sourceId: string, value: string): Promise<void> =>
  invoke("addon_secret_set", { sourceId, value });

export const deleteAddonSecret = (sourceId: string): Promise<void> =>
  invoke("addon_secret_delete", { sourceId });
