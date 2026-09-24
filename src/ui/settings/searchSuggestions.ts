import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

/**
 * Whether live search suggestions and top-result previews show while typing in the search overlay.
 *
 * Enabled by default to preserve the default search experience. When turned off, the search
 * overlay switches to a minimal centered search bar and disables live search network requests
 * until the user presses Enter.
 */
const SEARCH_SUGGESTIONS_KEY = "search-suggestions-enabled";
const CHANGE_EVENT = "search-suggestions-change";

export function readSearchSuggestionsEnabled(): boolean {
  return readLocalBooleanSetting(SEARCH_SUGGESTIONS_KEY, true);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setSearchSuggestionsEnabled(enabled: boolean) {
  writeLocalBooleanSetting(SEARCH_SUGGESTIONS_KEY, enabled, CHANGE_EVENT);
}

export async function hydrateSearchSuggestionsSetting() {
  await hydrateLocalBooleanSetting(SEARCH_SUGGESTIONS_KEY, true, CHANGE_EVENT);
}

export function useSearchSuggestionsEnabled() {
  return useSyncExternalStore(subscribe, readSearchSuggestionsEnabled, () => true);
}
