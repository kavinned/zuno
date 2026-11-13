export type SettingsTab = "about" | "appearance" | "playback" | "system" | "shortcuts" | "window";

export type SettingsSearchEntry = {
  id: string;
  tab: SettingsTab;
  category: string;
  title: string;
  description: string;
  /** Extra words that should find this row without repeating them in the description. */
  keywords?: string[];
};

/**
 * One entry per settings row.
 *
 * Kept in step with `SettingsPage.tsx` by `settingsSearchCoverage.check.ts`, which parses the
 * page's `SettingRow`/`SettingToggle` titles and fails when one has no entry here. That is the
 * guard against the index silently falling behind — add a row, add its entry.
 */
export const SETTINGS_ENTRIES: SettingsSearchEntry[] = [
  { id: "account", tab: "about", category: "Account", title: "Account", description: "Sign in and manage your YouTube Music account." },
  { id: "last-fm", tab: "about", category: "Account", title: "Last.fm", description: "Connect Last.fm and scrobble plays." },
  { id: "scrobble-plays", tab: "about", category: "Account", title: "Scrobble plays", description: "Send what you listen to to Last.fm.", keywords: ["last.fm", "history"] },
  { id: "discord-presence", tab: "about", category: "Account", title: "Discord presence", description: "Show what you are playing and hide status when paused." },
  { id: "discord-show-playing", tab: "about", category: "Account", title: "Show what you're playing", description: "Share the current track on your Discord profile.", keywords: ["discord", "status"] },
  { id: "discord-hide-paused", tab: "about", category: "Account", title: "Hide status when paused", description: "Stop showing a paused track on Discord.", keywords: ["discord", "presence"] },
  { id: "updates", tab: "about", category: "Account", title: "Updates", description: "Check for and install Zuno updates." },
  { id: "theme", tab: "appearance", category: "Appearance", title: "Theme", description: "Choose light, dark, or system theme." },
  { id: "app-size", tab: "appearance", category: "Appearance", title: "App size", description: "Zoom the whole app in or out. Ctrl + and Ctrl - work too." },
  { id: "motion", tab: "appearance", category: "Appearance", title: "Motion", description: "Control animations and visual effects." },
  { id: "potato-pc", tab: "appearance", category: "Appearance", title: "Potato PC", description: "Turn off animations, blur, shadows and the ambient artwork in one go.", keywords: ["performance", "reduce motion", "slow"] },
  { id: "toolbar", tab: "appearance", category: "Appearance", title: "Toolbar", description: "Choose which controls appear in the title bar." },
  { id: "onboarding", tab: "appearance", category: "Appearance", title: "Onboarding", description: "Restart the first-run introduction." },
  { id: "made-for-you", tab: "appearance", category: "Appearance", title: "Made for you", description: "Show personalized recommendations on Home." },
  { id: "output-device", tab: "playback", category: "Playback", title: "Output device", description: "Choose where Zuno sends audio." },
  { id: "playback-method", tab: "playback", category: "Playback", title: "Playback method", description: "Choose between the built-in player and the hidden YouTube frame.", keywords: ["audio engine", "native"] },
  { id: "normalize-volume", tab: "playback", category: "Playback", title: "Normalize volume", description: "Play every track at a similar loudness." },
  { id: "equalizer", tab: "playback", category: "Playback", title: "Equalizer", description: "Adjust audio frequencies and presets." },
  { id: "gapless-playback", tab: "playback", category: "Playback", title: "Gapless playback", description: "Remove silence between tracks." },
  { id: "crossfade", tab: "playback", category: "Playback", title: "Crossfade", description: "Blend the end of one track into the next." },
  { id: "restore-tabs", tab: "playback", category: "Playback", title: "Restore tabs and queues", description: "Restore your playback session after restarting." },
  { id: "audio-engine", tab: "playback", category: "Playback", title: "Audio engine", description: "Choose the playback method and authenticated streaming." },
  { id: "resolve-as-account", tab: "playback", category: "Playback", title: "Resolve streams as your account", description: "Attach your session when resolving a track for Premium bitrates.", keywords: ["authenticated", "premium", "quality"] },
  { id: "add-plays-history", tab: "playback", category: "Playback", title: "Add plays to YouTube Music history", description: "Report plays to YouTube Music so its recommendations learn from them.", keywords: ["scrobbling", "history", "recommendations"] },
  { id: "local-music", tab: "system", category: "Library", title: "Local music", description: "Create playlists from folders on this computer." },
  { id: "addon-sources", tab: "system", category: "Library", title: "Addon sources", description: "Servers that supply lossless streams in place of YouTube's audio." },
  { id: "cache", tab: "system", category: "Library", title: "Cache", description: "Set cache size and clear cached content." },
  { id: "downloads", tab: "system", category: "Library", title: "Downloads", description: "Set offline storage limits and remove downloads." },
  { id: "streaming-quality", tab: "system", category: "Library", title: "Streaming quality", description: "Choose quality for music played over the network." },
  { id: "download-quality", tab: "system", category: "Library", title: "Download quality", description: "Choose quality for offline music." },
  { id: "lyrics", tab: "system", category: "Library", title: "Lyrics", description: "Translate lyrics, set text size, and choose a source." },
  { id: "translate-lyrics", tab: "system", category: "Library", title: "Translate lyrics", description: "Show a translation or romanization under each line.", keywords: ["romanize", "language"] },
  { id: "lyrics-text-size", tab: "system", category: "Library", title: "Lyrics text size", description: "Scale the lyrics screen text.", keywords: ["font", "size"] },
  { id: "animated-album-covers", tab: "system", category: "Library", title: "Animated album covers", description: "Apple Music's moving artwork on the lyrics screen, when available.", keywords: ["motion", "cover", "apple"] },
  { id: "expanded-cover-default", tab: "system", category: "Library", title: "Expanded cover by default", description: "Open the lyrics screen with the cover already in its split layout.", keywords: ["cover", "layout", "split"] },
  { id: "preferred-lyrics-source", tab: "system", category: "Library", title: "Preferred lyrics source", description: "Which lyrics service is tried first for a song.", keywords: ["lyrics", "source"] },
  { id: "launch-at-startup", tab: "system", category: "Library", title: "Launch at startup", description: "Start Zuno when your computer starts." },
  { id: "remember-window", tab: "system", category: "Library", title: "Remember window size and location", description: "Restore the main window geometry." },
  { id: "troubleshooting", tab: "system", category: "Library", title: "Troubleshooting", description: "Open logs or reset Zuno data." },
  { id: "mini-player", tab: "window", category: "Window", title: "Mini player", description: "Show a compact player when the main window loses focus." },
  { id: "mini-player-hover-bar", tab: "window", category: "Window", title: "Mini player hover bar", description: "Choose what the expanded hover slider controls.", keywords: ["mini player", "seek", "volume"] },
  { id: "library-sidebar", tab: "window", category: "Window", title: "Library sidebar", description: "Choose the playlist rail size and hover behavior." },
  { id: "window-controls", tab: "window", category: "Window", title: "Window controls", description: "Choose macOS, Windows, or native title-bar buttons." },
  { id: "compositor-controls", tab: "window", category: "Window", title: "Show on this compositor", description: "Draw window buttons on a tiling compositor that hides them.", keywords: ["linux", "window controls"] },
  { id: "minimize-to-tray", tab: "window", category: "Window", title: "Minimize to tray", description: "Keep Zuno available from the system tray." },
  { id: "compact-player-bar", tab: "window", category: "Window", title: "Compact player bar", description: "Use a smaller playback bar." },
  { id: "extra-controls", tab: "window", category: "Window", title: "Always show extra controls", description: "Keep lyrics and queue visible instead of showing them only on hover." },
  { id: "hide-like-button", tab: "window", category: "Behavior", title: "Hide like button", description: "Remove the like button from the player bar." },
  { id: "hide-add-playlist-button", tab: "window", category: "Behavior", title: "Hide add to playlist button", description: "Remove the add to playlist button from the player bar." },
  { id: "search-suggestions", tab: "window", category: "Behavior", title: "Search suggestions", description: "Show live suggestions and a top-result preview while you type.", keywords: ["autocomplete", "search"] },
  { id: "system-media-controls", tab: "window", category: "Window", title: "Show in system media controls", description: "Show playback in system media controls.", keywords: ["media keys"] },
  { id: "window-outline", tab: "window", category: "Window", title: "Window outline", description: "Show or hide the thin edge around the window." },
  { id: "keyboard-shortcuts", tab: "shortcuts", category: "Shortcuts", title: "Keyboard shortcuts", description: "View, record, or clear keyboard bindings." },
];

/** Stable DOM id for a settings row, used to scroll a search result into view. */
export function settingAnchorId(title: string): string {
  return `setting-${title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

export function searchSettings(query: string): SettingsSearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return SETTINGS_ENTRIES.filter((entry) => {
    const haystack = `${entry.category} ${entry.title} ${entry.description} ${(entry.keywords ?? []).join(" ")}`
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
