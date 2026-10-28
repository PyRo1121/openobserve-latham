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

import type {
  HistoryContext,
  HistoryStatus,
  HistoryTime,
  QueryHistoryEntry,
} from "@/services/query_history";

/** Rows in the focus dropdown and the clock-button popover. */
export const POPOVER_ROWS = 8;
/** Clock rows offered in autocomplete while typing. */
export const AUTOCOMPLETE_ROWS = 5;
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 1000;
const CANCELLED_CODE = 20009;
const TIMEOUT_CODE = 20010;
const QUERY_ERROR_CODES = new Set([20001, 20002, 20003, 20004, 20005, 20007, 20008, 20011]);
const DAY_MS = 86_400_000;

export interface KeyParts {
  streams: string[];
  mode: string;
  query: string;
  vrl?: string;
}

/** A failed run as the page saw it: the search error code, the HTTP status, the message. */
export interface RunError {
  code?: number;
  httpStatus?: number;
  message?: string;
}

export interface RunResult {
  status: HistoryStatus;
  error?: string;
  warning?: string;
}

export interface RecentRow {
  entry: QueryHistoryEntry;
  /** Any row with the same query is starred. */
  starred: boolean;
}

export interface RecentsView {
  pinnedFailure: RecentRow | null;
  rows: RecentRow[];
  failedCount: number;
}

export type RestoreTime = "now" | "original";

export type RestoreWindow =
  { type: "relative"; period: string } | { type: "absolute"; startUs: number; endUs: number };

/** What an editor needs from its open recent-searches dropdown to hand it keys. */
export interface RecentsKeyTarget {
  focusFirst: () => boolean;
  pickFirst: (event: KeyboardEvent) => boolean;
}

export interface DayGroup {
  /** Local midnight of the day, in milliseconds. */
  dayMs: number;
  /** 0 for today, 1 for yesterday, and so on. */
  daysAgo: number;
  entries: QueryHistoryEntry[];
}

/** Runs with the same streams, mode, query and VRL on the same UTC day merge into one row. */
export const buildQueryKey = (parts: KeyParts, runAt: Date): string =>
  [
    parts.streams.join(","),
    parts.mode,
    parts.query,
    parts.vrl ?? "",
    runAt.toISOString().slice(0, 10),
  ].join("|");

/** One row per query in the dropdown and autocomplete, whatever day it ran. */
export const dedupeKey = (entry: Pick<QueryHistoryEntry, "source" | "streams" | "query">) =>
  `${entry.source}|${entry.streams.join(",")}|${entry.query.trim()}`;

/** Message text without HTML markup, capped so the context stays small. */
export const plainMessage = (message: unknown): string =>
  String(message ?? "")
    // Only HTML tags: PromQL errors quote tokens such as `<EOF>`.
    .replace(/<\/?(br|span|b|i|em|strong|p|div|code)\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);

/** A search error from any transport; a streamed error event carries the HTTP status in `code`. */
export const toRunError = (error: {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}): RunError => {
  const code = Number(error.code);
  const status = Number(error.status);
  const httpStatus = status >= 100 && status < 600 ? status : undefined;
  return {
    ...(code >= 20000 ? { code } : {}),
    ...(code >= 100 && code < 600 && httpStatus === undefined ? { httpStatus: code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    message: String(error.message ?? ""),
  };
};

/** Null for a cancelled run, which is never recorded; only query errors count as failures. */
export const runResultFromError = (err: RunError): RunResult | null => {
  if (err.code === CANCELLED_CODE) return null;
  const message = plainMessage(err.message);
  const timedOut = err.code === TIMEOUT_CODE || err.httpStatus === 408 || err.httpStatus === 504;
  if (timedOut) return { status: "ok", warning: message };
  const clientError =
    err.httpStatus !== undefined &&
    err.httpStatus >= 400 &&
    err.httpStatus < 500 &&
    err.httpStatus !== 429;
  if ((err.code !== undefined && QUERY_ERROR_CODES.has(err.code)) || clientError) {
    return { status: "error", error: message };
  }
  return { status: "ok", warning: message };
};

export const resultContext = (result: RunResult): Pick<HistoryContext, "error" | "warning"> => ({
  ...(result.error !== undefined ? { error: result.error } : {}),
  ...(result.warning !== undefined ? { warning: result.warning } : {}),
});

const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** The backend refuses a context over 64 KB; columns go first, the query, VRL and time never. */
export const fitContext = (context: HistoryContext): HistoryContext => {
  if (jsonBytes(context) <= MAX_CONTEXT_BYTES || !context.page?.columns) return context;
  const page = { ...context.page };
  delete page.columns;
  return { ...context, page };
};

/** The 8-row list: newest first, one row per query, the latest failure pinned on top. */
export const buildRecents = (entries: QueryHistoryEntry[], limit = POPOVER_ROWS): RecentsView => {
  const sorted = [...entries].sort((a, b) => b.updated_at - a.updated_at);
  const starredKeys = new Set(sorted.filter((e) => e.starred).map(dedupeKey));
  const seen = new Set<string>();
  const latest = sorted.filter((entry) => {
    const key = dedupeKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const toRow = (entry: QueryHistoryEntry): RecentRow => ({
    entry,
    starred: starredKeys.has(dedupeKey(entry)),
  });
  const pinned = latest[0]?.status === "error" ? latest[0] : null;
  const failedCount = latest.filter((e) => e.status === "error" && e !== pinned).length;
  const rows = latest
    .filter((e) => e.status !== "error")
    .slice(0, pinned ? limit - 1 : limit)
    .map(toRow);
  return { pinnedFailure: pinned ? toRow(pinned) : null, rows, failedCount };
};

/** Queries of the recent successful runs, newest first, one per query. */
export const recentQueryList = (entries: QueryHistoryEntry[]): string[] => [
  ...new Set(buildRecents(entries, entries.length).rows.map(({ entry }) => entry.query.trim())),
];

/** Recent queries that contain the typed text, prefix matches first. */
export const matchRecentQueries = (
  queries: string[],
  typed: string,
  limit = AUTOCOMPLETE_ROWS,
): string[] => {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const needle = flat(typed);
  if (needle.length < 2) return [];
  return queries
    .map((query) => ({ query, at: flat(query).indexOf(needle) }))
    .filter(({ query, at }) => at >= 0 && flat(query) !== needle)
    .sort((a, b) => Number(b.at === 0) - Number(a.at === 0))
    .slice(0, limit)
    .map(({ query }) => query);
};

const localDayStart = (ms: number) => {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** Re-run over a window ending now when the row last ran today; otherwise at its own window. */
export const defaultRestoreTime = (entry: QueryHistoryEntry, now = Date.now()): RestoreTime =>
  localDayStart(entry.updated_at / 1000) === localDayStart(now) ? "now" : "original";

/** The window a restore applies, or null when the row carries no time. */
export const restoreWindow = (
  time: HistoryTime | undefined,
  when: RestoreTime,
  nowUs = Date.now() * 1000,
): RestoreWindow | null => {
  if (!time) return null;
  if (when === "original") {
    return { type: "absolute", startUs: time.start_time, endUs: time.end_time };
  }
  if (time.type === "relative" && time.period) return { type: "relative", period: time.period };
  const span = Math.max(0, time.end_time - time.start_time);
  return { type: "absolute", startUs: nowUs - span, endUs: nowUs };
};

/** Rows grouped by the local day they last ran, newest day first. */
export const groupByDay = (entries: QueryHistoryEntry[], now = Date.now()): DayGroup[] => {
  const today = localDayStart(now);
  const groups = new Map<number, DayGroup>();
  for (const entry of entries) {
    const dayMs = localDayStart(entry.updated_at / 1000);
    let group = groups.get(dayMs);
    if (!group) {
      group = { dayMs, daysAgo: Math.round((today - dayMs) / DAY_MS), entries: [] };
      groups.set(dayMs, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()].sort((a, b) => b.dayMs - a.dayMs);
};

/** Local-day bounds of a `YYYY-MM-DD` date, in microseconds, for the "Ran on" filter. */
export const dayBoundsUs = (date: string): { ran_from: number; ran_to: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime();
  return { ran_from: start * 1000, ran_to: end * 1000 - 1 };
};

/** Absolute URL of a page route with its query string. */
export const absoluteLink = (href: string, origin = window.location.origin): string =>
  new URL(href, origin).href;

/** After an edit the focus dropdown shows only on an empty editor, and reopens only when the edit empties it. */
export const recentsOpenAfterEdit = (open: boolean, wasEmpty: boolean, isEmpty: boolean): boolean =>
  isEmpty && (open || !wasEmpty);

/** True inside the Monaco query editor itself, not the AI prompt or buttons that share its box. */
export const isQueryEditorInput = (target: EventTarget | null): boolean => {
  const el = target instanceof Node && !(target instanceof Element) ? target.parentElement : target;
  return el instanceof Element && !!el.closest(".monaco-editor");
};

/** Routes an editor key to its open recent-searches dropdown; bind in the capture phase. */
export const routeEditorKeyToRecents = (
  event: KeyboardEvent,
  dropdown: RecentsKeyTarget | null,
  close: () => void,
) => {
  if (!isQueryEditorInput(event.target)) return;
  if (event.key === "Escape") {
    close();
    return;
  }
  // The editor's own suggestion list keeps its arrows and Enter.
  const box = event.currentTarget instanceof Element ? event.currentTarget : null;
  if (box?.querySelector(".suggest-widget.visible")) return;
  if (event.key === "ArrowDown" && dropdown?.focusFirst()) {
    event.preventDefault();
    return;
  }
  const plainEnter = event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (plainEnter && dropdown?.pickFirst(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
};
