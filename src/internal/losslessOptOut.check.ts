export {};

const storage = new Map<string, string>();
const events: string[] = [];
let appSettings: Record<string, unknown> = {};
let appSettingWrites: Array<{ key: string; value: unknown }> = [];
let storageWritable = true;

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (!storageWritable) throw new Error("storage is full");
      storage.set(key, value);
    },
    removeItem: (key: string) => void storage.delete(key),
  },
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
    __TAURI_INTERNALS__: {
      invoke: (cmd: string, args?: { key?: string; value?: unknown }) => {
        if (cmd === "app_setting_set") {
          appSettingWrites.push({ key: String(args?.key), value: args?.value });
          return Promise.resolve(null);
        }
        return Promise.resolve(
          cmd === "app_setting_get" && args?.key ? appSettings[args.key] ?? null : null,
        );
      },
      transformCallback: () => 0,
    },
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const {
  isLosslessOptedOut,
  setLosslessOptOut,
  hydrateLosslessOptOuts,
} = await import("./losslessOptOut");

const KEY = "zuno.lossless-opt-outs.v1";
const stored = () => JSON.parse(storage.get(KEY) ?? "[]") as string[];

check(!isLosslessOptedOut("abc"), "a missing key reads as opted in");

setLosslessOptOut("abc", true);
check(isLosslessOptedOut("abc"), "opting out is immediate");
equal(stored().join(","), "abc", "the id is persisted to localStorage");
check(events.includes("lossless-opt-outs-change"), "the change event fires");

setLosslessOptOut("abc", true);
equal(stored().length, 1, "repeating an opt-out does not duplicate the id");

setLosslessOptOut("abc", false);
check(!isLosslessOptedOut("abc"), "undo clears the id");
equal(stored().length, 0, "undo persists an empty list");

/* A refused write must not make the click's own reload substitute FLAC again. */
storageWritable = false;
setLosslessOptOut("quota", true);
check(isLosslessOptedOut("quota"), "a failed localStorage write still opts out for this session");
check(!stored().includes("quota"), "nothing was written while storage refused");
storageWritable = true;
setLosslessOptOut("quota", false);
check(!isLosslessOptedOut("quota"), "the next successful write persists the clear");

setLosslessOptOut("abc", true);
storage.clear();
check(!isLosslessOptedOut("abc"), "a cleared localStorage clears the opt-out");

storage.set(KEY, JSON.stringify([1, "valid", ""]));
await hydrateLosslessOptOuts();
check(isLosslessOptedOut("valid"), "invalid stored entries are ignored, valid ones kept");
check(!isLosslessOptedOut(""), "an empty id is not kept");

/* Corrupt JSON is an empty list, never a throw. */
storage.set(KEY, "{not json");
check(!isLosslessOptedOut("valid"), "malformed JSON reads as empty");

/* Local ids with no settings-file value are backfilled to the durable copy. */
appSettings = {};
appSettingWrites = [];
storage.set(KEY, JSON.stringify(["backfill-me"]));
await hydrateLosslessOptOuts();
check(isLosslessOptedOut("backfill-me"), "local ids hydrate when the settings file has none");
check(
  appSettingWrites.some(
    (write) => write.key === KEY && JSON.stringify(write.value).includes("backfill-me"),
  ),
  "a local-only value is backfilled to the settings file",
);

appSettings = { [KEY]: ["from-settings"] };
await hydrateLosslessOptOuts();
check(isLosslessOptedOut("from-settings"), "hydration prefers the settings file");

console.log("losslessOptOut: ok");
