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

import type { QueryHistoryEntry } from "@/services/query_history";
import { logsRouteQuery } from "./logs";
import { metricsRouteQuery } from "./metrics";
import { tracesRouteQuery } from "./traces";
import type { RestoreTime } from "./recentSearches";

export interface RecentSearchRoute {
  path: string;
  query: Record<string, string>;
}

/** Where a row reopens; a landing on that page runs it, except a Logs re-apply. */
export const recentSearchRoute = (
  entry: QueryHistoryEntry,
  when: RestoreTime,
  orgId: string,
  reapply = false,
): RecentSearchRoute | null => {
  if (entry.source === "logs") {
    return { path: "/logs", query: logsRouteQuery(entry, when, orgId, reapply) };
  }
  if (entry.source === "traces") {
    return { path: "/traces", query: { ...tracesRouteQuery(entry, when, orgId), reload: "true" } };
  }
  if (entry.source === "metrics") {
    const query = metricsRouteQuery(entry, when, orgId);
    return query ? { path: "/metrics", query } : null;
  }
  return null;
};
