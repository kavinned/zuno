export {};

import { searchSettings, settingAnchorId } from "./settingsSearchIndex";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(searchSettings("").length === 0, "empty search has no results");
check(
  searchSettings("discord pause").some((entry) => entry.title === "Discord presence" && entry.tab === "about"),
  "search matches terms across a setting description",
);
check(
  searchSettings("quality").some((entry) => entry.title === "Streaming quality"),
  "search finds a library setting",
);
check(searchSettings("this cannot match").length === 0, "unknown query has no results");
check(
  searchSettings("motion").some((entry) => entry.title === "Animated album covers"),
  "keywords make a setting findable by a word it does not contain",
);
check(
  settingAnchorId("Animated album covers") === "setting-animated-album-covers",
  "anchors are derived from the title",
);

console.log("settingsSearch.check.ts passed");
