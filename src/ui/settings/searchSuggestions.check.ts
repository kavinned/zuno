export {};

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(
    actual === expected,
    `${message}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

const {
  readSearchSuggestionsEnabled,
  setSearchSuggestionsEnabled,
} = await import("./searchSuggestions");

equal(readSearchSuggestionsEnabled(), true, "search suggestions enabled by default");

setSearchSuggestionsEnabled(false);
equal(readSearchSuggestionsEnabled(), false, "search suggestions can be turned off");
equal(store.get("search-suggestions-enabled"), "false", "stored as false in storage");

setSearchSuggestionsEnabled(true);
equal(readSearchSuggestionsEnabled(), true, "search suggestions can be turned back on");
equal(store.get("search-suggestions-enabled"), "true", "stored as true in storage");

console.log("searchSuggestions self-check passed");
