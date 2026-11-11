/** The FLAC metadata the addon path can learn about the playing stream. */
export interface AddonAudioInfo {
  sampleRateHz?: number;
  bitDepth?: number;
  kbps?: number;
}

/** `"44.1 kHz · 16-bit · 1411 kbps"`, omitting whatever is unknown; `""` when nothing is. */
export function formatAddonAudioInfo(info: AddonAudioInfo): string {
  const parts: string[] = [];
  if (info.sampleRateHz !== undefined) {
    parts.push(`${Number((info.sampleRateHz / 1000).toFixed(1))} kHz`);
  }
  if (info.bitDepth !== undefined) parts.push(`${info.bitDepth}-bit`);
  if (info.kbps !== undefined) parts.push(`${info.kbps} kbps`);
  return parts.join(" · ");
}
