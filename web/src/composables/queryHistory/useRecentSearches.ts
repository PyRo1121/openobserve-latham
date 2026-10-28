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

import { computed, provide, ref, type InjectionKey, type Ref } from "vue";
import { useStore } from "vuex";
import { useMutation, useQuery } from "@tanstack/vue-query";
import { useOrgId } from "@/composables/query/useOrgId";
import {
  clearQueryHistoryMutation,
  deleteQueryHistoryMutation,
  recentSearchesQuery,
  recordQueryHistoryMutation,
  starQueryHistoryMutation,
} from "@/services/query_history.queries";
import type {
  HistorySource,
  QueryHistoryClearParams,
  QueryHistoryRecordBody,
} from "@/services/query_history";

const DEFAULT_RETENTION_DAYS = 14;

export const RECENT_SEARCHES_COLUMN: InjectionKey<RecentSearchesColumn> =
  Symbol("recentSearchesColumn");

export interface RecentSearchesColumn {
  pane: Ref<HTMLElement | null>;
}

/** Shared record, star, delete and clear; everything is off when the server disables history. */
export const useRecentSearches = () => {
  const store = useStore();
  const orgId = useOrgId();
  const enabled = computed(() => store.state.zoConfig?.query_history_enabled !== false);
  const retentionDays = computed(() => {
    const days = Number(store.state.zoConfig?.query_history_retention_days);
    return Number.isFinite(days) ? days : DEFAULT_RETENTION_DAYS;
  });

  const recordEntry = useMutation(() => recordQueryHistoryMutation(orgId.value));
  const starEntry = useMutation(() => starQueryHistoryMutation(orgId.value));
  const deleteEntry = useMutation(() => deleteQueryHistoryMutation(orgId.value));
  const clearEntries = useMutation(() => clearQueryHistoryMutation(orgId.value));

  /** Fire-and-forget: a failed record is only logged and never reaches the search. */
  const record = (body: QueryHistoryRecordBody | null) => {
    if (!body || !enabled.value || !orgId.value) return;
    recordEntry.mutateAsync(body).catch((err: unknown) => {
      console.error("Failed to record query history", err);
    });
  };

  const star = (id: string, starred: boolean) => starEntry.mutate({ id, starred });
  const remove = (id: string) => deleteEntry.mutate(id);
  const clear = (params: QueryHistoryClearParams) => clearEntries.mutateAsync(params);

  return { orgId, enabled, retentionDays, record, star, remove, clear };
};

/** The recent rows of one page, fetched only while `active` is true. */
export const useRecentSearchesList = (source: HistorySource, active: Ref<boolean>) => {
  const store = useStore();
  const orgId = useOrgId();
  return useQuery(() =>
    Object.assign(recentSearchesQuery(orgId.value, source), {
      enabled:
        active.value && !!orgId.value && store.state.zoConfig?.query_history_enabled !== false,
    }),
  );
};

/** Provides the column to the page's focus dropdown; bind the returned ref to the results pane. */
export const provideRecentSearchesColumn = () => {
  const pane = ref<HTMLElement | null>(null);
  provide(RECENT_SEARCHES_COLUMN, { pane });
  return pane;
};
