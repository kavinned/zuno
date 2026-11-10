import type { AudioQuality } from "../../internal/audioQuality";
import type {
  AddonManifest,
  AddonManifestSetting,
  AddonSearchRow,
  AddonStreamAnswer,
} from "./types";

export type AddonManifestErrorKind = "not-addon" | "no-search";

export class AddonManifestError extends Error {
  readonly kind: AddonManifestErrorKind;

  constructor(kind: AddonManifestErrorKind, message: string) {
    super(message);
    this.name = "AddonManifestError";
    this.kind = kind;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false;
  }
  return undefined;
}

function parseSetting(value: unknown): AddonManifestSetting | null {
  const record = asRecord(value);
  const key = nonBlankString(record?.key);
  if (!record || key === undefined) return null;

  const setting: AddonManifestSetting = {
    key,
    options: Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          const optionValue = nonBlankString(asRecord(option)?.value);
          return optionValue === undefined ? [] : [{ value: optionValue }];
        })
      : [],
  };
  const fallback = record.default;
  if (typeof fallback === "string" || typeof fallback === "number" || typeof fallback === "boolean") {
    setting.defaultValue = fallback;
  }
  return setting;
}

export function parseManifest(value: unknown): AddonManifest {
  const record = asRecord(value);
  const id = nonBlankString(record?.id);
  if (!record || id === undefined) {
    throw new AddonManifestError("not-addon", "The addon manifest has no id.");
  }

  const resources = Array.isArray(record.resources)
    ? record.resources.filter((resource): resource is string => typeof resource === "string")
    : [];
  if (resources.length > 0 && !resources.some((resource) => resource.trim().toLowerCase() === "search")) {
    throw new AddonManifestError("no-search", "The addon does not offer search.");
  }

  return {
    id,
    name: nonBlankString(record.name),
    version: nonBlankString(record.version),
    resources,
    settings: Array.isArray(record.settings)
      ? record.settings
          .map(parseSetting)
          .filter((setting): setting is AddonManifestSetting => setting !== null)
      : [],
    allowDownloads: parseBooleanLike(record.allowDownloads) ?? true,
    checkValidLossless: parseBooleanLike(record.checkValidLossless) ?? false,
  };
}

function nonBlankStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((entry): entry is string => nonBlankString(entry) !== undefined);
  return values.length > 0 ? values : undefined;
}

export function parseSearchResponse(value: unknown): AddonSearchRow[] {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.tracks)) return [];

  const rows: AddonSearchRow[] = [];
  for (const entry of record.tracks) {
    const track = asRecord(entry);
    const id = nonBlankString(track?.id);
    const title = nonBlankString(track?.title);
    if (!track || id === undefined || title === undefined) continue;

    const duration = track.duration;
    const singleMode = nonBlankString(track.audioMode);
    const row: AddonSearchRow = {
      id,
      title,
      artist: nonBlankString(track.artist),
      album: nonBlankString(track.album),
      durationSec: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : undefined,
      artworkUrl: nonBlankString(track.artworkURL) ?? nonBlankString(track.albumArtworkURL),
      format: nonBlankString(track.format),
      audioQuality: nonBlankString(track.audioQuality),
      audioModes: nonBlankStringArray(track.audioModes) ?? (singleMode === undefined ? undefined : [singleMode]),
      atmos: parseBooleanLike(track.atmos),
      streamUrl: nonBlankString(track.streamURL),
    };
    rows.push(row);
  }
  return rows;
}

export function parseStreamAnswer(value: unknown): AddonStreamAnswer {
  const record = asRecord(value);
  return record ? ({ ...record } as AddonStreamAnswer) : {};
}

const QUALITY_SETTING_KEY = "quality";
const ATMOS_SETTING_KEY = "atmos";

const TIER_BY_QUALITY: Record<AudioQuality, string> = {
  low: "LOW",
  normal: "HIGH",
  high: "HIGH",
};

const TIER_SYNONYMS: Record<string, readonly string[]> = {
  LOSSLESS: ["lossless", "flac", "hifi", "hi-res", "hires", "max", "best"],
  HIGH: ["high", "320", "normal", "standard"],
  LOW: ["low", "96", "128", "min"],
};

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function negotiatedQuality(setting: AddonManifestSetting, quality: AudioQuality): string {
  const candidates = setting.options
    .map((option) => option.value)
    .filter((value) => normalized(value) !== ATMOS_SETTING_KEY);
  const exact = candidates.find((value) => normalized(value) === quality);
  if (exact !== undefined) return exact;
  const tier = TIER_BY_QUALITY[quality];
  const synonym = candidates.find((value) => TIER_SYNONYMS[tier].includes(normalized(value)));
  return synonym ?? candidates[0] ?? tier;
}

export function addonQualityParams(
  manifest: AddonManifest | null,
  quality: AudioQuality,
): Array<[string, string]> {
  const tier = TIER_BY_QUALITY[quality];
  if (!manifest) return [[QUALITY_SETTING_KEY, tier]];

  const params: Array<[string, string]> = [];
  let hasQualitySetting = false;
  for (const setting of manifest.settings) {
    const key = normalized(setting.key);
    if (key === ATMOS_SETTING_KEY) continue;
    if (key === QUALITY_SETTING_KEY) {
      hasQualitySetting = true;
      params.push([setting.key, negotiatedQuality(setting, quality)]);
      continue;
    }
    if (setting.defaultValue !== undefined) params.push([setting.key, String(setting.defaultValue)]);
  }
  if (!hasQualitySetting) params.push([QUALITY_SETTING_KEY, tier]);
  return params;
}
