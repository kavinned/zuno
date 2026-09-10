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
    TRANSLATION_OFF,
    ROMANIZATION_MODE,
    getLyricsTranslationLang,
    setLyricsTranslationLang,
    getLyricsTranslationSwapped,
    setLyricsTranslationSwapped,
} = await import("./lyricsTranslation");

equal(getLyricsTranslationSwapped(), false, "swapped defaults to false");

setLyricsTranslationSwapped(true);
equal(getLyricsTranslationSwapped(), true, "swapped can be toggled on");
equal(
    store.get("lyrics-translation-swapped"),
    "true",
    "stored in localStorage",
);

setLyricsTranslationSwapped(false);
equal(getLyricsTranslationSwapped(), false, "swapped can be toggled off");
check(
    !store.has("lyrics-translation-swapped"),
    "cleared from storage when false",
);

equal(getLyricsTranslationLang(), TRANSLATION_OFF, "lang defaults to off");
setLyricsTranslationLang(ROMANIZATION_MODE);
equal(
    getLyricsTranslationLang(),
    ROMANIZATION_MODE,
    "lang sets to romanization",
);

console.log("lyricsTranslation self-check passed");
