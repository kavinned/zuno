export {};

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

const EMPTY: SearchResults = { artists: [], tracks: [], albums: [], playlists: [] };

function results(tracks: Track[]): SearchResults {
  return { ...EMPTY, tracks };
}

function youtubeTrack(id: string): Track {
  return { id, source: "youtube", title: `YouTube ${id}`, artist: "Artist" };
}

function ids(value: SearchResults): string {
  return value.tracks.map((track) => track.id).join(",");
}

class FakeDataSource extends DataSource {
  mixedResults: SearchResults = results([youtubeTrack("yt1")]);
  tracks: Track[] = [];
  categoryResults: SearchResults = results([youtubeTrack("yt1")]);
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
    _query: string,
    onUpdate?: (next: SearchResults) => void,
  ): Promise<SearchResults> {
    this.searchCalls += 1;
    this.lastUpdate = onUpdate;
    return this.mixedResults;
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
  const source = new FakeDataSource();
  const controller = new SearchController(source);
  const updates: SearchResults[] = [];

  const first = await controller.search("  q  ", (next) => updates.push(next));
  equal(ids(first), "yt1", "YouTube results are returned");
  equal(source.searchCalls, 1, "the data source is searched once");
  equal(updates.length, 0, "the returned result is not re-sent");

  source.lastUpdate?.(results([youtubeTrack("yt2")]));
  equal(ids(updates[0]), "yt2", "background updates are forwarded");
}

{
  const source = new FakeDataSource();
  source.tracks = [youtubeTrack("yt1")];
  const controller = new SearchController(source);

  const tracks = await controller.searchTracks("q");
  equal(tracks.map((track) => track.id).join(","), "yt1", "searchTracks returns tracks");
  equal(source.searchTracksCalls, 1, "searchTracks calls the data source");
}

{
  const source = new FakeDataSource();
  const library = new LibraryController(source);

  equal(ids(await library.searchCategory("q", "song")), "yt1", "song category is YouTube-only");
  equal(ids(await library.searchCategory("q", "video")), "yt1", "video category is YouTube-only");
  equal(source.categoryCalls.join(","), "song,video", "categories are forwarded");
}

{
  setOnline(false);
  const source = new FakeDataSource();
  const controller = new SearchController(source);

  const offline = await controller.search("q");
  equal(offline.tracks.length, 0, "offline search answers from downloads only");
  equal(source.searchCalls, 0, "offline search never calls the data source");
  setOnline(true);
}

console.log("SearchController: ok");
