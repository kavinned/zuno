export {};

const storage = new Map<string, string>();
const events: string[] = [];
let appSettings: Record<string, unknown> = {};

Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
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
      invoke: (cmd: string, args?: { key?: string }) =>
        Promise.resolve(
          cmd === "app_setting_get" && args?.key ? appSettings[args.key] ?? null : null,
        ),
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

setLosslessOptOut("abc", true);
storage.clear();
check(!isLosslessOptedOut("abc"), "a cleared localStorage clears the opt-out");

storage.set(KEY, JSON.stringify([1, "valid", ""]));
await hydrateLosslessOptOuts();
check(!isLosslessOptedOut("valid"), "invalid stored entries are discarded");

appSettings = { [KEY]: ["from-settings"] };
await hydrateLosslessOptOuts();
check(isLosslessOptedOut("from-settings"), "hydration prefers the settings file");

console.log("losslessOptOut: ok");
