import type { DataSource } from "../datasource/DataSource";
import type { SearchResults, Track } from "../datasource/types";
import { isOnline } from "../internal/connectivity";
import { searchDownloads } from "./offlineStore";

const EMPTY_RESULTS: SearchResults = { artists: [], tracks: [], albums: [], playlists: [] };

export class SearchController {
  constructor(private readonly dataSource: DataSource) {}

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

    if (this.dataSource.search) {
      return this.dataSource.search(normalizedQuery, onUpdate);
    }
    const tracks = await this.searchTracks(
      normalizedQuery,
      onUpdate ? (items) => onUpdate({ ...EMPTY_RESULTS, tracks: items }) : undefined,
    );
    return { ...EMPTY_RESULTS, tracks };
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
}
