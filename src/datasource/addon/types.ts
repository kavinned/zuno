export type AddonHealth = "ok" | "unreachable" | "rejected" | "gated" | "rate-limited";

export type AddonTransport = "progressive" | "hls" | "dash";

export interface AddonSourceConfig {
  id: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  order: number;
  allowDownloads: boolean;
  checkValidLossless: boolean;
  manifestName?: string;
  manifestVersion?: string;
  lastManifestAt?: number;
  lastHealth?: AddonHealth;
}

export interface PersistedAddonSource extends Omit<AddonSourceConfig, "baseUrl"> {}

export interface AddonManifestSetting {
  key: string;
  defaultValue?: string | number | boolean;
  options: Array<{ value: string }>;
}

export interface AddonManifest {
  id: string;
  name?: string;
  version?: string;
  resources: string[];
  settings: AddonManifestSetting[];
  allowDownloads: boolean;
  checkValidLossless: boolean;
}

export interface AddonSearchRow {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSec?: number;
  artworkUrl?: string;
  format?: string;
  audioQuality?: string;
  audioModes?: string[];
  atmos?: boolean;
  streamUrl?: string;
}

export interface AddonStreamAnswer {
  url?: string;
  format?: string;
  quality?: string;
  streamQuality?: string;
  audioQuality?: string;
  codec?: string;
  fileCodec?: string;
  container?: string;
  containerFormat?: string;
  manifest?: string;
  mediaType?: string;
  mimeType?: string;
  encrypted?: unknown;
  sampleRate?: number;
  bitDepth?: number;
  bitrate?: number;
  audioMode?: string;
  audioModes?: string[];
  error?: string;
  expiresAt?: string | number;
}

export interface AddonTrackRef {
  sourceId: string;
  trackId: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  artworkUrl?: string;
  format?: string;
  codec?: string;
  container?: string;
  mimeType?: string;
  sampleRateHz?: number;
  bitDepth?: number;
  kbps?: number;
  isLossless?: boolean;
  streamUrl?: string;
  expiresAt?: number;
  transport?: AddonTransport;
}
