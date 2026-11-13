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

/* Actual settings components with a literal title. Dynamic titles (`title={item.label}`) are
   covered by a `section: true` entry; other `title="…"` attributes (buttons, row labels) are
   not settings rows. Single quotes and template literals are allowed so the guard cannot be
   bypassed by a formatter-free edit. */
const rowTitles = new Set(
  [...source.matchAll(/<(?:SettingRow|SettingToggle|SettingsCardHeader)\b(?:[^>{}]|\{[^{}]*\})*?\btitle=(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]),
);
const registered = new Set(SETTINGS_ENTRIES.map((entry) => entry.title));

const missing = [...rowTitles].filter((title) => !registered.has(title)).sort();
check(
  missing.length === 0,
  `settings rows missing from the search registry: ${missing.join(", ")}`,
);

const unanchored = SETTINGS_ENTRIES
  .filter((entry) => !entry.section && !rowTitles.has(entry.title))
  .map((entry) => entry.title)
  .sort();
check(
  unanchored.length === 0,
  `search entries with neither a page title nor section: true: ${unanchored.join(", ")}`,
);

const ids = SETTINGS_ENTRIES.map((entry) => entry.id);
check(new Set(ids).size === ids.length, "search registry ids are unique");
const titles = SETTINGS_ENTRIES.map((entry) => entry.title);
check(new Set(titles).size === titles.length, "search registry titles are unique");

console.log("settingsSearchCoverage.check.ts passed");
