import { useSyncExternalStore } from "react";
import {
    getAppSetting,
    removeAppSetting,
    setAppSetting,
} from "../../internal/appSettings";

/**
 * Target language for lyric translation, or "off".
 *
 * Off by default and off is a real value, not an absence: translation goes out to a
 * third-party endpoint with the words of whatever is playing, so it happens because someone
 * asked for it rather than because nobody changed a setting.
 */
const STORAGE_KEY = "lyrics-translation-lang";
const CHANGE_EVENT = "lyrics-translation-change";

export const TRANSLATION_OFF = "off";

/**
 * When selected, the secondary lyric line shows source-language romanization (romaji, pinyin,
 * RR, etc.) instead of a translation. Stored in the same localStorage key as a translation
 * language code — the existing hook and setter handle it without modification.
 */
export const ROMANIZATION_MODE = "rm";

/** Codes the endpoint accepts; the labels come from the platform, not from a table here. */
export const TRANSLATION_LANGUAGES = [
    "en",
    "es",
    "fr",
    "de",
    "it",
    "pt",
    "ru",
    "tr",
    "ar",
    "hi",
    "ur",
    "ja",
    "ko",
    "zh-CN",
    "id",
    "vi",
    "th",
    "pl",
    "nl",
    "sv",
];

/**
 * Endonym-ish label via `Intl.DisplayNames` — already in the runtime, always in step with
 * the user's locale, and one less table to leave un-updated.
 */
export function getLanguageLabel(code: string): string {
    try {
        return (
            new Intl.DisplayNames(undefined, { type: "language" }).of(code) ??
            code
        );
    } catch {
        return code;
    }
}

const SWAP_STORAGE_KEY = "lyrics-translation-swapped";

export function getLyricsTranslationSwapped(): boolean {
    try {
        return localStorage.getItem(SWAP_STORAGE_KEY) === "true";
    } catch {
        return false;
    }
}

export function setLyricsTranslationSwapped(swapped: boolean): void {
    try {
        if (!swapped) localStorage.removeItem(SWAP_STORAGE_KEY);
        else localStorage.setItem(SWAP_STORAGE_KEY, "true");
    } catch {
        // Quota or a locked profile: the choice still applies for this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    if (!swapped) {
        void removeAppSetting(SWAP_STORAGE_KEY);
    } else {
        void setAppSetting(SWAP_STORAGE_KEY, "true");
    }
}

export function getLyricsTranslationLang(): string {
    try {
        return localStorage.getItem(STORAGE_KEY) || TRANSLATION_OFF;
    } catch {
        return TRANSLATION_OFF;
    }
}

export function setLyricsTranslationLang(lang: string): void {
    try {
        if (lang === TRANSLATION_OFF) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, lang);
    } catch {
        // Quota or a locked profile: the choice still applies for this session.
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
    if (lang === TRANSLATION_OFF) {
        void removeAppSetting(STORAGE_KEY);
    } else {
        void setAppSetting(STORAGE_KEY, lang);
    }
}

export async function hydrateLyricsTranslation(): Promise<void> {
    const stored = await getAppSetting<string>(STORAGE_KEY);
    const lang =
        typeof stored === "string" && stored.trim()
            ? stored
            : getLyricsTranslationLang();

    const storedSwapped = await getAppSetting<string>(SWAP_STORAGE_KEY);
    const swapped =
        typeof storedSwapped === "string"
            ? storedSwapped === "true"
            : getLyricsTranslationSwapped();

    try {
        if (lang === TRANSLATION_OFF) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, lang);

        if (!swapped) localStorage.removeItem(SWAP_STORAGE_KEY);
        else localStorage.setItem(SWAP_STORAGE_KEY, "true");
    } catch {
        // The UI still reflects the hydrated value below.
    }

    window.dispatchEvent(new Event(CHANGE_EVENT));

    if (typeof stored !== "string" && lang !== TRANSLATION_OFF) {
        void setAppSetting(STORAGE_KEY, lang);
    }
    if (typeof storedSwapped !== "string" && swapped) {
        void setAppSetting(SWAP_STORAGE_KEY, "true");
    }
}

function subscribe(listener: () => void): () => void {
    window.addEventListener(CHANGE_EVENT, listener);
    // Not optional in a multi-window app: without it the other window never sees the change.
    window.addEventListener("storage", listener);
    return () => {
        window.removeEventListener(CHANGE_EVENT, listener);
        window.removeEventListener("storage", listener);
    };
}

export function useLyricsTranslationLang(): string {
    return useSyncExternalStore(
        subscribe,
        getLyricsTranslationLang,
        () => TRANSLATION_OFF,
    );
}

export function useLyricsTranslationSwapped(): boolean {
    return useSyncExternalStore(
        subscribe,
        getLyricsTranslationSwapped,
        () => false,
    );
}
