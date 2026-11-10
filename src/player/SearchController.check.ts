export {};

import type { AudioQuality } from "../internal/audioQuality";
import { getStreamingQuality } from "../internal/audioQuality";
import { DataSource } from "../datasource/DataSource";
import type { SearchCategory, SearchResults, Track } from "../datasource/types";
import { setOnline } from "../internal/connectivity";
import { LibraryController } from "./LibraryController";
import { SearchController } from "./SearchController";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const EMPTY: SearchResults = { artists: [], tracks: [], albums: [], playlists: [] };

function results(tracks: Track[]): SearchResults {
  return { ...EMPTY, tracks };
}

function youtubeTrack(id: string): Track {
  return { id, source: "youtube", title: `YouTube ${id}`, artist: "Artist" };
}

function addonTrack(id: string): Track {
  return { id, source: "addon", title: `Addon ${id}`, artist: "Artist" };
}

function ids(resultsValue: SearchResults): string {
  return resultsValue.tracks.map((track) => track.id).join(",");
}

type AddonSearch = (query: string, quality: AudioQuality) => Promise<Track[]>;

class FakeAddons {
  readonly calls: Array<{ query: string; quality: AudioQuality }> = [];

  constructor(private readonly handler: AddonSearch) {}

  async search(query: string, quality: AudioQuality): Promise<Track[]> {
    this.calls.push({ query, quality });
    return this.handler(query, quality);
  }
}

class FakeDataSource extends DataSource {
  mixed: (query: string, onUpdate?: (results: SearchResults) => void) => Promise<SearchResults> =
    async () => EMPTY;
  tracks: Track[] = [];
  categoryResults: SearchResults = EMPTY;
  searchCalls = 0;
  searchTracksCalls = 0;
  categoryCalls: SearchCategory[] = [];
  lastUpdate: ((results: SearchResults) => void) | undefined;

  async getTrack(id: string): Promise<Track> {
    throw new Error(`unexpected getTrack(${id})`);
  }

  async getStreamUrl(): Promise<string> {
    return "";
  }

  async search(
    query: string,
    onUpdate?: (results: SearchResults) => void,
  ): Promise<SearchResults> {
    this.searchCalls += 1;
    this.lastUpdate = onUpdate;
    return this.mixed(query, onUpdate);
  }

  async searchTracks(_query: string): Promise<Track[]> {
    this.searchTracksCalls += 1;
    return this.tracks;
  }

  async searchCategory(_query: string, category: SearchCategory): Promise<SearchResults> {
    this.categoryCalls.push(category);
    return this.categoryResults;
  }
}

setOnline(true);

{
  const addon = deferred<Track[]>();
  const addons = new FakeAddons(() => addon.promise);
  const source = new FakeDataSource();
  source.mixed = async () => results([youtubeTrack("yt1")]);
  const controller = new SearchController(source, addons);
  const updates: SearchResults[] = [];

  const first = await controller.search("  q  ", (next) => updates.push(next));

  equal(ids(first), "yt1", "YouTube results return without waiting for the addon");
  equal(source.searchCalls, 1, "the data source is searched once");
  equal(addons.calls.length, 1, "the addon search starts in parallel");
  equal(addons.calls[0].query, "q", "the addon receives the trimmed query");
  equal(addons.calls[0].quality, getStreamingQuality(), "the addon receives the streaming quality");
  equal(updates.length, 0, "nothing is delivered before the addon settles");

  addon.resolve([addonTrack("addon1")]);
  await flush();

  equal(updates.length, 1, "addon results reach onUpdate exactly once");
  equal(ids(updates[0]), "yt1,addon1", "addon tracks appended in the update");

  await flush();
  equal(updates.length, 1, "the late update is not repeated");
}

{
  const addon = deferred<Track[]>();
  const addons = new FakeAddons(() => addon.promise);
  const source = new FakeDataSource();
  source.mixed = async () => results([youtubeTrack("yt1")]);
  const controller = new SearchController(source, addons);
  const updates: SearchResults[] = [];

  await controller.search("q", (next) => updates.push(next));
  addon.resolve([addonTrack("addon1")]);
  await flush();

  equal(updates.length, 1, "the addon update has landed");
  source.lastUpdate?.(results([youtubeTrack("yt2")]));
  equal(updates.length, 2, "a background YouTube refresh is still delivered");
  equal(ids(updates[1]), "yt2,addon1", "the background refresh keeps the addon tracks");
}

{
  const addon = deferred<Track[]>();
  const addons = new FakeAddons(() => addon.promise);
  const source = new FakeDataSource();
  source.mixed = async () => results([youtubeTrack("yt1")]);
  const controller = new SearchController(source, addons);

  let settled = false;
  const pending = controller.search("q").then((value) => {
    settled = true;
    return value;
  });

  await flush();
  equal(settled, false, "without onUpdate the search waits for the addon");

  addon.resolve([addonTrack("addon1")]);
  equal(ids(await pending), "yt1,addon1", "the awaited result includes the addon tracks");
}

{
  const addons = new FakeAddons(async () => {
    throw new Error("addon down");
  });
  const source = new FakeDataSource();
  source.mixed = async () => results([youtubeTrack("yt1")]);
  const controller = new SearchController(source, addons);

  const merged = await controller.search("q");
  equal(ids(merged), "yt1", "an addon failure leaves YouTube results unchanged");

  const updates: SearchResults[] = [];
  const first = await controller.search("q", (next) => updates.push(next));
  await flush();
  equal(ids(first), "yt1", "onUpdate mode also returns the YouTube results");
  equal(updates.length, 0, "a failed addon sends no late update");
}

{
  setOnline(false);
  const addons = new FakeAddons(async () => [addonTrack("addon1")]);
  const source = new FakeDataSource();
  source.mixed = async () => results([youtubeTrack("yt1")]);
  const controller = new SearchController(source, addons);

  const offline = await controller.search("q");
  equal(offline.tracks.length, 0, "offline search answers from downloads only");
  equal(addons.calls.length, 0, "offline search never calls addons");
  equal(source.searchCalls, 0, "offline search never calls the data source");
  setOnline(true);
}

{
  const addons = new FakeAddons(async () => [addonTrack("addon1")]);
  const source = new FakeDataSource();
  source.tracks = [youtubeTrack("yt1")];
  const controller = new SearchController(source, addons);

  const tracks = await controller.searchTracks("q");
  equal(tracks.map((track) => track.id).join(","), "yt1", "searchTracks returns YouTube tracks");
  equal(source.searchTracksCalls, 1, "searchTracks calls the data source");
  equal(addons.calls.length, 0, "searchTracks never calls addons");
}

{
  const addons = new FakeAddons(async () => [addonTrack("addon1")]);
  const source = new FakeDataSource();
  source.categoryResults = results([youtubeTrack("yt1")]);
  const library = new LibraryController(source, addons);

  const songs = await library.searchCategory("q", "song");
  equal(ids(songs), "yt1,addon1", "song category merges addon tracks after YouTube's");
  equal(addons.calls.length, 1, "song category searches the addons");
  equal(addons.calls[0].query, "q", "the addon receives the trimmed query");

  const videos = await library.searchCategory("q", "video");
  equal(ids(videos), "yt1", "video category stays YouTube-only");
  equal(addons.calls.length, 1, "video category never calls addons");
}

{
  const source = new FakeDataSource();
  source.categoryResults = results([youtubeTrack("yt1")]);
  const library = new LibraryController(source);

  const songs = await library.searchCategory("q", "song");
  equal(ids(songs), "yt1", "without addons the song category is unchanged");
}

{
  const addons = new FakeAddons(async () => {
    throw new Error("addon down");
  });
  const source = new FakeDataSource();
  source.categoryResults = results([youtubeTrack("yt1")]);
  const library = new LibraryController(source, addons);

  const songs = await library.searchCategory("q", "song");
  equal(ids(songs), "yt1", "an addon failure leaves the song category unchanged");
}

console.log("SearchController: ok");
