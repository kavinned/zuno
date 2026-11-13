export {};

import { SETTINGS_ENTRIES } from "./settingsSearchIndex";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

/*
 * `node:fs` has no type declarations in this project (no `@types/node`), and a check may not
 * add a dependency for that. `process.getBuiltinModule` reaches the same module without an
 * import; these checks only ever run under Node via `scripts/run-checks.mjs`.
 */
type NodeFs = { readFileSync(path: string, encoding: "utf8"): string };
const nodeProcess = (globalThis as {
  process?: { getBuiltinModule?: (id: string) => unknown };
}).process;
const fs = nodeProcess?.getBuiltinModule?.("fs") as NodeFs | undefined;

let source = "";
try {
  if (!fs) throw new Error("no fs");
  source = fs.readFileSync("src/ui/pages/SettingsPage.tsx", "utf8");
} catch {
  throw new Error("FAILED: cannot read src/ui/pages/SettingsPage.tsx (run from the repo root)");
}

/* Only actual row components with literal titles. Dynamic rows (`title={effect.label}`) are
   covered by their group entry, and other `title="…"` attributes (buttons, card headers) are
   not settings rows. */
const rowTitles = new Set(
  [...source.matchAll(/<Setting(?:Row|Toggle)\b[^>]*\btitle="([^"]+)"/g)]
    .map((match) => match[1]),
);
const registered = new Set(SETTINGS_ENTRIES.map((entry) => entry.title));

const missing = [...rowTitles].filter((title) => !registered.has(title)).sort();
check(
  missing.length === 0,
  `settings rows missing from the search registry: ${missing.join(", ")}`,
);

const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
check(new Set(ids).size === ids.length, "search registry ids are unique");
const titles = SETTINGS_ENTRIES.map((entry) => entry.title);
check(new Set(titles).size === titles.length, "search registry titles are unique");

console.log("settingsSearchCoverage.check.ts passed");
