/**
 * JSON for a persisted payload.
 *
 * An addon search row can carry a media URL signed for this session. It is only needed in
 * memory, for the direct-stream fallback, so it is dropped before anything reaches disk.
 */
export function serializePersisted(value: unknown): string {
  return JSON.stringify(value, (key, nested) => (key === "streamUrl" ? undefined : nested));
}
