// Copyright 2026 OpenObserve Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

import { infiniteQueryOptions, mutationOptions, queryOptions } from "@tanstack/vue-query";
import queryHistory, {
  type QueryHistoryClearParams,
  type QueryHistoryEntry,
  type QueryHistoryListParams,
  type QueryHistoryRecordBody,
} from "./query_history";
import { queryHistoryKeys } from "./query_history.querykeys";
import { MEDIUM_STALE_TIME } from "@/composables/query/cachePolicy";

export const QUERY_HISTORY_PAGE_SIZE = 50;
/** Rows fetched for the 8-row list; enough to dedupe repeats and count failures. */
export const RECENT_SEARCHES_FETCH_SIZE = 50;

const rowsOf = (data: unknown): QueryHistoryEntry[] =>
  Array.isArray(data) ? (data as QueryHistoryEntry[]) : [];

export const queryHistoryQuery = (org: string, filters: QueryHistoryListParams) =>
  infiniteQueryOptions({
    queryKey: queryHistoryKeys.list(org, filters),
    queryFn: async ({ pageParam }): Promise<QueryHistoryEntry[]> => {
      const res = await queryHistory.list(org, {
        ...filters,
        limit: QUERY_HISTORY_PAGE_SIZE,
        offset: pageParam,
      });
      return rowsOf(res.data);
    },
    initialPageParam: 0,
    // A short page is the last one.
    getNextPageParam: (last, pages) =>
      last.length < QUERY_HISTORY_PAGE_SIZE ? undefined : pages.length * QUERY_HISTORY_PAGE_SIZE,
    staleTime: MEDIUM_STALE_TIME,
  });

// Refetched on every open: another tab's runs must show up.
export const recentSearchesQuery = (org: string, source: string) =>
  queryOptions({
    queryKey: queryHistoryKeys.recent(org, source),
    queryFn: async (): Promise<QueryHistoryEntry[]> => {
      const res = await queryHistory.list(org, { source, limit: RECENT_SEARCHES_FETCH_SIZE });
      return rowsOf(res.data);
    },
    staleTime: 0,
  });

/** Rows a clear would delete, counted up to the list cap (200). */
export const QUERY_HISTORY_COUNT_CAP = 200;

export const queryHistoryCountQuery = (org: string, source: string, starred: boolean) =>
  queryOptions({
    queryKey: queryHistoryKeys.list(org, { source, starred, limit: QUERY_HISTORY_COUNT_CAP }),
    queryFn: async (): Promise<number> => {
      const res = await queryHistory.list(org, {
        ...(source ? { source } : {}),
        starred,
        limit: QUERY_HISTORY_COUNT_CAP,
      });
      return rowsOf(res.data).length;
    },
    staleTime: 0,
  });

// Never toasted: a failed record must not disturb the run it belongs to.
export const recordQueryHistoryMutation = (org: string) =>
  mutationOptions({
    mutationFn: (body: QueryHistoryRecordBody) => queryHistory.record(org, body),
    meta: { invalidates: [queryHistoryKeys.all(org)], silentError: true },
  });

export const starQueryHistoryMutation = (org: string) =>
  mutationOptions({
    mutationFn: (vars: { id: string; starred: boolean }) =>
      queryHistory.star(org, vars.id, vars.starred),
    meta: { invalidates: [queryHistoryKeys.all(org)] },
  });

export const deleteQueryHistoryMutation = (org: string) =>
  mutationOptions({
    mutationFn: (id: string) => queryHistory.remove(org, id),
    meta: { invalidates: [queryHistoryKeys.all(org)] },
  });

export const clearQueryHistoryMutation = (org: string) =>
  mutationOptions({
    mutationFn: (params: QueryHistoryClearParams) => queryHistory.clear(org, params),
    meta: { invalidates: [queryHistoryKeys.all(org)] },
  });
