/**
 * Parses a TTML time expression into seconds.
 *
 * lrc.red emits bare decimal seconds ("19.764"), while BetterLyrics emits clock forms and
 * metric offsets. All three are valid TTML time expressions, so the parser has to accept
 * them all — dropping one form silently drops every line of that provider's sheet.
 */
export function parseTtmlTime(value: string | null): number | undefined {
  if (!value) return undefined;

  const bareSeconds = value.match(/^(\d+(?:\.\d+)?)$/);
  if (bareSeconds) {
    const amount = Number(bareSeconds[1]);
    return Number.isFinite(amount) ? amount : undefined;
  }

  const clockTime = value.match(/^(\d+):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (clockTime) {
    const hours = Number(clockTime[1]);
    const minutes = Number(clockTime[2]);
    const seconds = Number(clockTime[3]);
    const fraction = clockTime[4] ?? "0";
    return hours * 3600 + minutes * 60 + seconds + Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
  }

  const minuteTime = value.match(/^(\d+):(\d{2})(?:[.:](\d{1,3}))?$/);
  if (minuteTime) {
    const minutes = Number(minuteTime[1]);
    const seconds = Number(minuteTime[2]);
    const fraction = minuteTime[3] ?? "0";
    return minutes * 60 + seconds + Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
  }

  const offsetTime = value.match(/^([\d.]+)(h|m|s|ms)$/);
  if (offsetTime) {
    const amount = Number(offsetTime[1]);
    if (!Number.isFinite(amount)) return undefined;
    if (offsetTime[2] === "h") return amount * 3600;
    if (offsetTime[2] === "m") return amount * 60;
    if (offsetTime[2] === "s") return amount;
    return amount / 1000;
  }

  return undefined;
}
