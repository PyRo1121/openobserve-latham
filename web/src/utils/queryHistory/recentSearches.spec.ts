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

import { describe, expect, it, vi } from "vitest";
import type { QueryHistoryEntry } from "@/services/query_history";
import {
  buildQueryKey,
  buildRecents,
  dayBoundsUs,
  dedupeKey,
  defaultRestoreTime,
  fitContext,
  groupByDay,
  matchRecentQueries,
  plainMessage,
  recentQueryList,
  recentsOpenAfterEdit,
  restoreWindow,
  routeEditorKeyToRecents,
  runResultFromError,
  toRunError,
} from "./recentSearches";

const HOUR_US = 3_600_000_000;
const NOW_MS = new Date(2026, 9, 27, 15, 0, 0).getTime();
const NOW_US = NOW_MS * 1000;

const entry = (overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
  id: "e",
  source: "logs",
  query: "level = 'error'",
  query_key: "k",
  streams: ["k8s"],
  context: {},
  status: "ok",
  starred: false,
  run_count: 1,
  created_at: NOW_US,
  updated_at: NOW_US,
  ...overrides,
});

describe("query key", () => {
  it("joins streams, mode, query, VRL and the UTC date of the run", () => {
    const key = buildQueryKey(
      { streams: ["a", "b"], mode: "sql", query: "SELECT 1", vrl: ".x = 1" },
      new Date("2026-10-27T23:30:00Z"),
    );
    expect(key).toBe("a,b|sql|SELECT 1|.x = 1|2026-10-27");
  });

  it("starts a new key on the next UTC day, so each day keeps its own row", () => {
    const parts = { streams: ["a"], mode: "filter", query: "x" };
    expect(buildQueryKey(parts, new Date("2026-10-27T23:59:59Z"))).not.toBe(
      buildQueryKey(parts, new Date("2026-10-28T00:00:00Z")),
    );
    expect(buildQueryKey(parts, new Date("2026-10-27T01:00:00Z"))).toBe(
      buildQueryKey(parts, new Date("2026-10-27T22:00:00Z")),
    );
  });

  it("dedupes rows of different days by source, streams and query, without the date", () => {
    const today = entry({ id: "t", query_key: "day-1" });
    const yesterday = entry({ id: "y", query_key: "day-0", query: " level = 'error' " });
    expect(dedupeKey(today)).toBe(dedupeKey(yesterday));
    expect(dedupeKey(entry({ streams: ["other"] }))).not.toBe(dedupeKey(today));
    expect(dedupeKey(entry({ source: "traces" }))).not.toBe(dedupeKey(today));
  });
});

describe("status mapping", () => {
  it("records a query error (search code or 4xx) as error with its message", () => {
    expect(runResultFromError({ code: 20001, message: "syntax <b>near</b> x" })).toEqual({
      status: "error",
      error: "syntax near x",
    });
    expect(runResultFromError({ httpStatus: 400, message: "bad" })).toEqual({
      status: "error",
      error: "bad",
    });
  });

  it("records a timeout as ok with a warning", () => {
    expect(runResultFromError({ code: 20010, message: "timed out" })).toEqual({
      status: "ok",
      warning: "timed out",
    });
    expect(runResultFromError({ httpStatus: 504 })).toEqual({ status: "ok", warning: "" });
    expect(runResultFromError({ httpStatus: 408 })?.status).toBe("ok");
  });

  it("reads a streamed error's `code` as an HTTP status and a refused request's as a search code", () => {
    expect(toRunError({ code: 400, message: "Search field not found" })).toEqual({
      httpStatus: 400,
      message: "Search field not found",
    });
    expect(toRunError({ status: 400, code: 20004, message: "m" })).toEqual({
      code: 20004,
      httpStatus: 400,
      message: "m",
    });
    expect(runResultFromError(toRunError({ code: 400, message: "bad" }))?.status).toBe("error");
    expect(runResultFromError(toRunError({ code: 500, message: "boom" }))?.status).toBe("ok");
  });

  it("never records a cancelled run", () => {
    expect(runResultFromError({ code: 20009 })).toBeNull();
  });

  it("keeps server and rate-limit failures out of the failed list", () => {
    expect(runResultFromError({ httpStatus: 500, message: "boom" })).toEqual({
      status: "ok",
      warning: "boom",
    });
    expect(runResultFromError({ httpStatus: 429 })?.status).toBe("ok");
  });

  it("strips markup and caps the message", () => {
    expect(plainMessage("a <br><span>TraceID: 1</span>")).toBe("a TraceID: 1");
    expect(plainMessage("unexpected <EOF>")).toBe("unexpected <EOF>");
    expect(plainMessage("x".repeat(5000))).toHaveLength(1000);
  });
});

describe("context size", () => {
  it("drops the columns first and keeps the query, VRL and time", () => {
    const page = { stream: "a", functionContent: "vrl", columns: "c".repeat(70 * 1024) };
    const time = { type: "relative" as const, period: "15m", start_time: 1, end_time: 2 };
    const fitted = fitContext({ page, time });
    expect(fitted.page).toEqual({ stream: "a", functionContent: "vrl" });
    expect(fitted.time).toEqual(time);
  });

  it("leaves a small context alone", () => {
    const context = { page: { columns: "abc" } };
    expect(fitContext(context)).toBe(context);
  });
});

describe("the 8-row list", () => {
  it("shows at most 8 rows, newest first, one per query", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `e${i}`, query: `q${i % 10}`, updated_at: NOW_US - i * HOUR_US }),
    );
    const view = buildRecents(entries);
    expect(view.rows.map((r) => r.entry.id)).toEqual([
      "e0",
      "e1",
      "e2",
      "e3",
      "e4",
      "e5",
      "e6",
      "e7",
    ]);
    expect(view.pinnedFailure).toBeNull();
  });

  it("pins the newest run when it failed and counts the older failures", () => {
    const view = buildRecents([
      entry({ id: "fail", query: "bad", status: "error", updated_at: NOW_US }),
      entry({ id: "ok", query: "good", updated_at: NOW_US - HOUR_US }),
      entry({ id: "old-fail", query: "worse", status: "error", updated_at: NOW_US - 2 * HOUR_US }),
    ]);
    expect(view.pinnedFailure?.entry.id).toBe("fail");
    expect(view.rows.map((r) => r.entry.id)).toEqual(["ok"]);
    expect(view.failedCount).toBe(1);
  });

  it("keeps the pinned failure inside the 8 rows", () => {
    const entries = [
      entry({ id: "fail", query: "bad", status: "error", updated_at: NOW_US }),
      ...Array.from({ length: 10 }, (_, i) =>
        entry({ id: `e${i}`, query: `q${i}`, updated_at: NOW_US - (i + 1) * HOUR_US }),
      ),
    ];
    expect(buildRecents(entries).rows).toHaveLength(7);
  });

  it("marks a row starred when another day's row of the same query is starred", () => {
    const view = buildRecents([
      entry({ id: "today", updated_at: NOW_US }),
      entry({ id: "monday", starred: true, updated_at: NOW_US - 48 * HOUR_US }),
    ]);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]).toMatchObject({ starred: true, entry: { id: "today" } });
  });
});

describe("autocomplete matches", () => {
  const queries = recentQueryList([
    entry({ id: "a", query: "level = 'error' and ns = 'checkout'", updated_at: NOW_US }),
    entry({ id: "b", query: "ns = 'cart' and level = 'warn'", updated_at: NOW_US - 1 }),
    entry({ id: "c", query: "broken", status: "error", updated_at: NOW_US - 2 }),
  ]);

  it("offers recent queries containing the typed text, prefix matches first", () => {
    expect(matchRecentQueries(queries, "LEVEL")).toEqual([
      "level = 'error' and ns = 'checkout'",
      "ns = 'cart' and level = 'warn'",
    ]);
    expect(matchRecentQueries(queries, "ns =")).toEqual([
      "ns = 'cart' and level = 'warn'",
      "level = 'error' and ns = 'checkout'",
    ]);
  });

  it("needs two characters and never offers failed or identical queries", () => {
    expect(matchRecentQueries(queries, "l")).toEqual([]);
    expect(matchRecentQueries(queries, "broken")).toEqual([]);
    expect(matchRecentQueries(queries, "ns = 'cart' and level = 'warn'")).toEqual([]);
  });
});

describe("restore time", () => {
  it("re-runs a row that last ran today ending now, an older one at its own window", () => {
    expect(defaultRestoreTime(entry({ updated_at: NOW_US - HOUR_US }), NOW_MS)).toBe("now");
    expect(defaultRestoreTime(entry({ updated_at: NOW_US - 24 * HOUR_US }), NOW_MS)).toBe(
      "original",
    );
  });

  it("restores a relative run as its period now and as its absolute window at original time", () => {
    const time = { type: "relative" as const, period: "15m", start_time: 10, end_time: 20 };
    expect(restoreWindow(time, "now")).toEqual({ type: "relative", period: "15m" });
    expect(restoreWindow(time, "original")).toEqual({
      type: "absolute",
      startUs: 10,
      endUs: 20,
    });
  });

  it("moves an absolute run's span to end now", () => {
    const time = { type: "absolute" as const, start_time: 100, end_time: 400 };
    expect(restoreWindow(time, "now", 1000)).toEqual({
      type: "absolute",
      startUs: 700,
      endUs: 1000,
    });
    expect(restoreWindow(undefined, "now")).toBeNull();
  });
});

describe("drawer helpers", () => {
  it("groups rows by the local day they last ran", () => {
    const groups = groupByDay(
      [
        entry({ id: "a", updated_at: NOW_US }),
        entry({ id: "b", updated_at: NOW_US - HOUR_US }),
        entry({ id: "c", updated_at: NOW_US - 24 * HOUR_US }),
      ],
      NOW_MS,
    );
    expect(groups.map((g) => [g.daysAgo, g.entries.map((e) => e.id)])).toEqual([
      [0, ["a", "b"]],
      [1, ["c"]],
    ]);
  });

  it("turns a Ran on date into local-day bounds in microseconds", () => {
    const bounds = dayBoundsUs("2026-10-27");
    expect(bounds?.ran_from).toBe(new Date(2026, 9, 27).getTime() * 1000);
    expect(bounds?.ran_to).toBe(new Date(2026, 9, 28).getTime() * 1000 - 1);
    expect(dayBoundsUs("yesterday")).toBeNull();
  });
});

describe("editor keys routed to the open recent-searches dropdown", () => {
  const dispatch = (
    key: string,
    init: KeyboardEventInit = {},
    dropdown = { focusFirst: vi.fn(() => true), pickFirst: vi.fn(() => true) },
    suggestOpen = false,
  ) => {
    const box = document.createElement("div");
    if (suggestOpen) {
      const widget = document.createElement("div");
      widget.className = "suggest-widget visible";
      box.appendChild(widget);
    }
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    const editor = document.createElement("textarea");
    monaco.appendChild(editor);
    box.appendChild(monaco);
    const close = vi.fn();
    box.addEventListener("keydown", (e) => routeEditorKeyToRecents(e, dropdown, close), true);
    const editorSaw = vi.fn();
    editor.addEventListener("keydown", editorSaw);
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    editor.dispatchEvent(event);
    return { event, close, dropdown, editorSaw };
  };

  it("closes on Escape and still lets the editor handle it", () => {
    const { event, close, editorSaw } = dispatch("Escape");
    expect(close).toHaveBeenCalledOnce();
    expect(editorSaw).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it("hands ArrowDown to the list", () => {
    const { event, dropdown } = dispatch("ArrowDown");
    expect(dropdown.focusFirst).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes Enter and Shift+Enter for the first row, so the editor adds no newline", () => {
    for (const shiftKey of [false, true]) {
      const { event, dropdown, editorSaw } = dispatch("Enter", { shiftKey });
      expect(dropdown.pickFirst).toHaveBeenCalledWith(event);
      expect(event.defaultPrevented).toBe(true);
      expect(editorSaw).not.toHaveBeenCalled();
    }
  });

  it("leaves Ctrl/Cmd+Enter (run query) and Tab to the editor", () => {
    for (const [key, init] of [
      ["Enter", { ctrlKey: true }],
      ["Enter", { metaKey: true }],
      ["Tab", {}],
    ] as const) {
      const { event, dropdown, editorSaw } = dispatch(key, init);
      expect(dropdown.pickFirst).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(editorSaw).toHaveBeenCalledOnce();
    }
  });

  it("leaves arrows and Enter to the editor's open suggestion list", () => {
    for (const key of ["ArrowDown", "Enter"]) {
      const { event, dropdown, editorSaw } = dispatch(key, {}, undefined, true);
      expect(dropdown.focusFirst).not.toHaveBeenCalled();
      expect(dropdown.pickFirst).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(editorSaw).toHaveBeenCalledOnce();
    }
  });

  it("lets Enter through when the list has nothing to pick", () => {
    const empty = { focusFirst: vi.fn(() => false), pickFirst: vi.fn(() => false) };
    const { event, editorSaw } = dispatch("Enter", { shiftKey: true }, empty);
    expect(event.defaultPrevented).toBe(false);
    expect(editorSaw).toHaveBeenCalledOnce();
  });

  it("ignores keys from other controls in the editor box, such as the AI prompt", () => {
    const dropdown = { focusFirst: vi.fn(() => true), pickFirst: vi.fn(() => true) };
    const box = document.createElement("div");
    const prompt = document.createElement("input");
    box.appendChild(prompt);
    const close = vi.fn();
    box.addEventListener("keydown", (e) => routeEditorKeyToRecents(e, dropdown, close), true);
    for (const [key, shiftKey] of [
      ["Enter", false],
      ["Enter", true],
      ["ArrowDown", false],
      ["Escape", false],
    ] as const) {
      const event = new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      prompt.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(dropdown.pickFirst).not.toHaveBeenCalled();
    expect(dropdown.focusFirst).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("focus dropdown after an edit", () => {
  it("opens when an edit empties the editor and closes on the next character", () => {
    expect(recentsOpenAfterEdit(false, false, true)).toBe(true);
    expect(recentsOpenAfterEdit(true, true, false)).toBe(false);
    expect(recentsOpenAfterEdit(false, false, false)).toBe(false);
  });

  it("stays open while the editor stays empty", () => {
    expect(recentsOpenAfterEdit(true, true, true)).toBe(true);
  });

  it("stays dismissed until the editor is emptied again", () => {
    expect(recentsOpenAfterEdit(false, true, true)).toBe(false);
    expect(recentsOpenAfterEdit(false, true, false)).toBe(false);
    expect(recentsOpenAfterEdit(false, false, true)).toBe(true);
  });
});
