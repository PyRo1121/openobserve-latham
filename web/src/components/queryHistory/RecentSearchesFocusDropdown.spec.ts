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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import store from "@/test/unit/helpers/store";
import {
  RECENT_SEARCHES_COLUMN,
  type RecentSearchesColumn,
} from "@/composables/queryHistory/useRecentSearches";

const api = vi.hoisted(() => ({ list: vi.fn(), record: vi.fn(), star: vi.fn(), remove: vi.fn() }));
vi.mock("@/services/query_history", () => ({ default: api }));

import RecentSearchesFocusDropdown from "./RecentSearchesFocusDropdown.vue";

enableAutoUnmount(afterEach);

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const boxed = ({ left, top, right, bottom }: Box) => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      right,
      bottom,
      x: left,
      y: top,
      width: right - left,
      height: bottom - top,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
};

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
};

const panel = () =>
  document.querySelector<HTMLElement>('[data-test="recent-searches-focus-dropdown"]');

const mountDropdown = (anchor: HTMLElement, column: RecentSearchesColumn | null) =>
  mount(RecentSearchesFocusDropdown, {
    props: { source: "logs", anchor, open: true },
    attachTo: document.body,
    global: {
      plugins: [store],
      provide: column ? { [RECENT_SEARCHES_COLUMN as symbol]: column } : {},
      stubs: { RecentSearchesPopover: true },
    },
  });

const LAYOUTS = {
  "Logs, no results, 1440x900": {
    viewport: [1440, 900],
    editor: { left: 89, top: 88, right: 1431, bottom: 125 },
    pane: { left: 357, top: 125, right: 1431, bottom: 891 },
    picker: { left: 101, top: 135, right: 344, bottom: 169 },
  },
  "Logs with results and histogram, 1280x800": {
    viewport: [1280, 800],
    editor: { left: 89, top: 87, right: 1271, bottom: 124 },
    pane: { left: 325, top: 124, right: 1271, bottom: 791 },
    picker: { left: 101, top: 135, right: 312, bottom: 169 },
  },
  "Logs Patterns, 1440x900": {
    viewport: [1440, 900],
    editor: { left: 89, top: 87, right: 1431, bottom: 124 },
    pane: { left: 357, top: 124, right: 1431, bottom: 891 },
    picker: { left: 101, top: 135, right: 344, bottom: 169 },
  },
  "Traces with rate/errors/duration charts, 1440x900": {
    viewport: [1440, 900],
    editor: { left: 89, top: 88, right: 1431, bottom: 129 },
    pane: { left: 357, top: 130, right: 1431, bottom: 891 },
    picker: { left: 101, top: 136, right: 344, bottom: 170 },
  },
} as const;

describe("RecentSearchesFocusDropdown placement", () => {
  beforeEach(() => {
    store.state.zoConfig.query_history_enabled = true;
  });
  afterEach(() => {
    delete store.state.zoConfig.query_history_enabled;
    setViewport(1024, 768);
    document.body.innerHTML = "";
  });

  it.each(Object.entries(LAYOUTS))(
    "%s: opens directly under the editor, from the results column's left edge",
    (_name, layout) => {
      setViewport(layout.viewport[0], layout.viewport[1]);
      mountDropdown(boxed(layout.editor), { pane: ref(boxed(layout.pane)) });
      const style = panel()!.style;
      const left = parseFloat(style.left);
      const top = parseFloat(style.top);
      expect(top).toBe(layout.editor.bottom + 2);
      expect(left).toBe(layout.pane.left + 8);
      expect(left).toBeGreaterThan(layout.picker.right);
      expect(left + parseFloat(style.maxWidth)).toBe(layout.pane.right - 8);
      expect(top + parseFloat(style.maxHeight)).toBeLessThanOrEqual(layout.viewport[1]);
    },
  );

  it("ignores toolbars and charts in the results column, which it may cover while open", () => {
    setViewport(1440, 900);
    const layout = LAYOUTS["Traces with rate/errors/duration charts, 1440x900"];
    const charts = boxed({ left: 357, top: 130, right: 1431, bottom: 330 });
    const pane = boxed(layout.pane);
    pane.appendChild(charts);
    mountDropdown(boxed(layout.editor), { pane: ref(pane) });
    expect(parseFloat(panel()!.style.top)).toBe(131);
  });

  it("Metrics: opens inside an editor that reaches the viewport bottom, under its first line", () => {
    setViewport(1440, 900);
    mountDropdown(boxed({ left: 437, top: 215, right: 1380, bottom: 891 }), null);
    const style = panel()!.style;
    expect(parseFloat(style.top)).toBe(215 + 40);
    expect(parseFloat(style.left)).toBe(437 + 8);
    expect(parseFloat(style.left) + parseFloat(style.maxWidth)).toBe(1380 - 8);
    expect(parseFloat(style.top) + parseFloat(style.maxHeight)).toBeLessThanOrEqual(891);
  });

  it("Metrics: opens directly under a short editor that leaves room below", () => {
    setViewport(1280, 800);
    mountDropdown(boxed({ left: 405, top: 215, right: 1220, bottom: 400 }), null);
    expect(parseFloat(panel()!.style.top)).toBe(402);
  });

  it("never opens off-screen: a results column with no room under the editor keeps it closed", async () => {
    setViewport(1280, 300);
    const wrapper = mountDropdown(boxed({ left: 89, top: 88, right: 1271, bottom: 200 }), {
      pane: ref(boxed({ left: 325, top: 200, right: 1271, bottom: 300 })),
    });
    await nextTick();
    expect(panel()).toBeNull();
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
  });

  it("brings an editor focused at the bottom of the viewport into view, then opens inside it", () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 856, right: 1380, bottom: 1532 });
    const scrollIntoView = vi.fn(() => {
      editor.getBoundingClientRect = boxed({
        left: 437,
        top: 215,
        right: 1380,
        bottom: 891,
      }).getBoundingClientRect;
    });
    editor.scrollIntoView = scrollIntoView;
    mountDropdown(editor, null);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    const style = panel()!.style;
    expect(parseFloat(style.top)).toBe(215 + 40);
    expect(parseFloat(style.top) + parseFloat(style.maxHeight)).toBeLessThanOrEqual(891);
  });

  it("stays closed when the editor cannot be brought into view", async () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 856, right: 1380, bottom: 1532 });
    editor.scrollIntoView = vi.fn();
    const wrapper = mountDropdown(editor, null);
    await nextTick();
    expect(panel()).toBeNull();
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
  });

  it("follows the editor when its page scrolls, and ignores scrolling elsewhere", async () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 215, right: 1380, bottom: 891 });
    mountDropdown(editor, null);
    expect(parseFloat(panel()!.style.top)).toBe(255);

    editor.getBoundingClientRect = boxed({
      left: 437,
      top: 300,
      right: 1380,
      bottom: 976,
    }).getBoundingClientRect;
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(parseFloat(panel()!.style.top)).toBe(255);

    document.body.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(parseFloat(panel()!.style.top)).toBe(340);
  });

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  const moveTo = (el: HTMLElement, box: Box) => {
    el.getBoundingClientRect = boxed(box).getBoundingClientRect;
  };

  it("Metrics: follows the editor when a chart above pushes it down after opening, instead of closing", async () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 633, right: 1380, bottom: 1309 });
    const scrollIntoView = vi.fn(() =>
      moveTo(editor, { left: 437, top: 215, right: 1380, bottom: 891 }),
    );
    editor.scrollIntoView = scrollIntoView;
    const wrapper = mountDropdown(editor, null);
    expect(parseFloat(panel()!.style.top)).toBe(673);

    moveTo(editor, { left: 437, top: 710, right: 1380, bottom: 1386 });
    await nextFrame();
    await nextFrame();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(panel()).not.toBeNull();
    expect(parseFloat(panel()!.style.top)).toBe(255);
    expect(wrapper.emitted("update:open")).toBeUndefined();
  });

  it("Metrics: follows the editor when an errored run moves it up after opening", async () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 633, right: 1380, bottom: 1309 });
    editor.scrollIntoView = vi.fn();
    const wrapper = mountDropdown(editor, null);
    expect(parseFloat(panel()!.style.top)).toBe(673);

    moveTo(editor, { left: 437, top: 215, right: 1380, bottom: 891 });
    await nextFrame();
    await nextFrame();

    expect(parseFloat(panel()!.style.top)).toBe(255);
    expect(editor.scrollIntoView).not.toHaveBeenCalled();
    expect(wrapper.emitted("update:open")).toBeUndefined();
  });

  it("re-places on a synthetic window resize, as Metrics dispatches one after an edit", async () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 215, right: 1380, bottom: 891 });
    const wrapper = mountDropdown(editor, null);
    moveTo(editor, { left: 437, top: 300, right: 1380, bottom: 976 });
    window.dispatchEvent(new Event("resize"));
    await nextTick();
    expect(wrapper.emitted("update:open")).toBeUndefined();
    expect(parseFloat(panel()!.style.top)).toBe(340);
  });

  it("closes, without scrolling back, when the user scrolls the editor out of reach", async () => {
    setViewport(1440, 900);
    const editor = boxed({ left: 437, top: 215, right: 1380, bottom: 891 });
    editor.scrollIntoView = vi.fn();
    const wrapper = mountDropdown(editor, null);
    moveTo(editor, { left: 437, top: 860, right: 1380, bottom: 1536 });
    document.body.dispatchEvent(new Event("scroll"));
    await nextTick();
    expect(editor.scrollIntoView).not.toHaveBeenCalled();
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
  });

  it("stays closed while the page's results pane is hidden", async () => {
    setViewport(1280, 900);
    const wrapper = mountDropdown(
      boxed(LAYOUTS["Logs with results and histogram, 1280x800"].editor),
      {
        pane: ref(boxed({ left: 0, top: 0, right: 0, bottom: 0 })),
      },
    );
    await nextTick();
    expect(panel()).toBeNull();
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
  });
});

describe("RecentSearchesFocusDropdown outside clicks", () => {
  beforeEach(() => {
    store.state.zoConfig.query_history_enabled = true;
    setViewport(1280, 900);
  });
  afterEach(() => {
    delete store.state.zoConfig.query_history_enabled;
    setViewport(1024, 768);
    document.body.innerHTML = "";
  });

  it("closes on a pointerdown elsewhere and lets that click reach its target", async () => {
    const layout = LAYOUTS["Logs with results and histogram, 1280x800"];
    const picker = document.createElement("button");
    document.body.appendChild(picker);
    const onPicker = vi.fn();
    picker.addEventListener("click", onPicker);
    const seenPointerdown = vi.fn();
    document.addEventListener("pointerdown", seenPointerdown);
    const wrapper = mountDropdown(boxed(layout.editor), {
      pane: ref(boxed(layout.pane)),
    });
    expect(panel()).not.toBeNull();

    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    picker.dispatchEvent(down);
    picker.click();
    await nextTick();

    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
    expect(down.defaultPrevented).toBe(false);
    expect(seenPointerdown).toHaveBeenCalledTimes(1);
    expect(onPicker).toHaveBeenCalledTimes(1);
    document.removeEventListener("pointerdown", seenPointerdown);
  });

  it("stays open on a pointerdown in the editor or the panel", async () => {
    const layout = LAYOUTS["Logs with results and histogram, 1280x800"];
    const editor = boxed(layout.editor);
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    editor.appendChild(monaco);
    const wrapper = mountDropdown(editor, { pane: ref(boxed(layout.pane)) });
    monaco.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    panel()!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(wrapper.emitted("update:open")).toBeUndefined();
    expect(panel()).not.toBeNull();
  });
});

describe("RecentSearchesFocusDropdown when the editor resizes while open", () => {
  const observers: {
    callback: ResizeObserverCallback;
    targets: Element[];
    boxes: (ResizeObserverBoxOptions | undefined)[];
  }[] = [];
  const RealResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    store.state.zoConfig.query_history_enabled = true;
    setViewport(1280, 800);
    observers.length = 0;
    globalThis.ResizeObserver = class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [], boxes: [] };
        observers.push(this.entry);
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        this.entry.targets.push(target);
        this.entry.boxes.push(options?.box);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    } as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = RealResizeObserver;
    delete store.state.zoConfig.query_history_enabled;
    setViewport(1024, 768);
    document.body.innerHTML = "";
  });

  const fireResize = () =>
    observers.forEach((o) => {
      if (o.targets.length) o.callback([], {} as ResizeObserver);
    });

  it("stays directly under a growing editor and closes once it would go off-screen", async () => {
    const layout = LAYOUTS["Logs with results and histogram, 1280x800"];
    const editor = boxed(layout.editor);
    const pane = boxed(layout.pane);
    const wrapper = mountDropdown(editor, { pane: ref(pane) });
    const active = observers.find((o) => o.targets.length);
    expect(active?.targets).toEqual(expect.arrayContaining([editor, pane]));
    expect(new Set(active?.boxes)).toEqual(new Set(["border-box"]));
    expect(parseFloat(panel()!.style.top)).toBe(126);

    editor.getBoundingClientRect = boxed({ ...layout.editor, bottom: 300 }).getBoundingClientRect;
    fireResize();
    await nextTick();
    expect(parseFloat(panel()!.style.top)).toBe(302);

    editor.getBoundingClientRect = boxed({ ...layout.editor, bottom: 700 }).getBoundingClientRect;
    fireResize();
    await nextTick();
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
  });
});
