import type { DataSource } from "../datasource/DataSource";
import type { AddonService } from "../datasource/addon/service";
import type { SearchResults, Track } from "../datasource/types";
import { getStreamingQuality } from "../internal/audioQuality";
import { isOnline } from "../internal/connectivity";
import { searchDownloads } from "./offlineStore";

type AddonSearch = Pick<AddonService, "search">;

const EMPTY_RESULTS: SearchResults = { artists: [], tracks: [], albums: [], playlists: [] };

export class SearchController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly addons?: AddonSearch,
  ) {}

  async search(
    query: string,
    onUpdate?: (results: SearchResults) => void,
  ): Promise<SearchResults> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { ...EMPTY_RESULTS };
    }
    if (!isOnline()) {
      return { ...EMPTY_RESULTS, tracks: searchDownloads(normalizedQuery) };
    }

    let latestYoutube = EMPTY_RESULTS;
    let latestAddons: Track[] = [];
    let addonsSettled = false;
    const mergeAddons = (base: SearchResults): SearchResults => ({
      ...base,
      tracks: [...base.tracks, ...latestAddons],
    });

    const addonPromise = this.searchAddons(normalizedQuery).then((tracks) => {
      latestAddons = tracks;
      addonsSettled = true;
      return tracks;
    });

    /*
     * A late update is only needed when the addon is still pending: an addon that already
     * settled is folded into the value `search` returns, so a second delivery would only
     * overwrite that merged state from the caller's own reaction to the return value.
     */
    const deliverLateAddons = (): void => {
      if (!onUpdate) return;
      void addonPromise.then((tracks) => {
        if (tracks.length > 0) onUpdate(mergeAddons(latestYoutube));
      });
    };

    if (this.dataSource.search) {
      const youtubeResults = await this.dataSource.search(
        normalizedQuery,
        onUpdate
          ? (results) => {
              latestYoutube = results;
              onUpdate(mergeAddons(results));
            }
          : undefined,
      );
      latestYoutube = youtubeResults;
      if (!onUpdate) {
        latestAddons = await addonPromise;
        return mergeAddons(youtubeResults);
      }
      if (addonsSettled) return mergeAddons(youtubeResults);
      deliverLateAddons();
      return youtubeResults;
    }

    const tracks = await this.searchTracks(
      normalizedQuery,
      onUpdate
        ? (items) => {
            latestYoutube = { ...EMPTY_RESULTS, tracks: items };
            onUpdate(mergeAddons(latestYoutube));
          }
        : undefined,
    );
    latestYoutube = { ...EMPTY_RESULTS, tracks };
    if (!onUpdate) {
      latestAddons = await addonPromise;
      return mergeAddons(latestYoutube);
    }
    if (addonsSettled) return mergeAddons(latestYoutube);
    deliverLateAddons();
    return latestYoutube;
  }

  async searchTracks(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !this.dataSource.searchTracks) return [];
    if (!isOnline()) return searchDownloads(normalizedQuery);
    return this.dataSource.searchTracks(normalizedQuery, onUpdate);
  }

  async getSearchSuggestions(
    query: string,
    onUpdate?: (suggestions: string[]) => void,
  ): Promise<string[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || !this.dataSource.getSearchSuggestions || !isOnline()) return [];
    return this.dataSource.getSearchSuggestions(normalizedQuery, onUpdate);
  }

  /** A failing addon is its own business; the service has already recorded its health. */
  private async searchAddons(query: string): Promise<Track[]> {
    if (!this.addons) return [];
    try {
      return await this.addons.search(query, getStreamingQuality());
    } catch {
      return [];
    }
  }
}
