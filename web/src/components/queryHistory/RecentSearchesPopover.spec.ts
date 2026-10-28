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
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import store from "@/test/unit/helpers/store";
import type { QueryHistoryEntry } from "@/services/query_history";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  record: vi.fn(),
  star: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
}));
vi.mock("@/services/query_history", () => ({ default: api }));

import RecentSearchesPopover from "./RecentSearchesPopover.vue";
import RecentSearchesButton from "./RecentSearchesButton.vue";
import RecentSearchesFocusDropdown from "./RecentSearchesFocusDropdown.vue";
import {
  routeEditorKeyToRecents,
  type RecentsKeyTarget,
} from "@/utils/queryHistory/recentSearches";

enableAutoUnmount(afterEach);

const NOW_US = Date.now() * 1000;

const setWidths = (el: Element, scrollWidth: number, clientWidth: number) => {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: clientWidth });
};
const HOUR_US = 3_600_000_000;

const row = (i: number, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
  id: `e${i}`,
  source: "logs",
  query: `q${i}`,
  query_key: "k",
  streams: ["k8s"],
  context: {},
  status: "ok",
  starred: false,
  run_count: 1,
  created_at: NOW_US - i * HOUR_US,
  updated_at: NOW_US - i * HOUR_US,
  ...overrides,
});

const mountPopover = (props: Record<string, unknown> = {}) =>
  mount(RecentSearchesPopover, {
    props: { source: "logs", active: true, ...props },
    global: { plugins: [store], stubs: { OTimeCell: true, OTooltip: true } },
  });

const rowIds = (wrapper: ReturnType<typeof mountPopover>) =>
  wrapper
    .findAll('[data-test^="recent-searches-row-"]')
    .map((r) => r.attributes("data-test")?.replace("recent-searches-row-", ""));

describe("RecentSearchesPopover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.state.zoConfig.query_history_enabled = true;
  });
  afterEach(() => {
    delete store.state.zoConfig.query_history_enabled;
  });

  it("asks for this page's recents and shows 8 rows", async () => {
    api.list.mockResolvedValue({ data: Array.from({ length: 12 }, (_, i) => row(i)) });
    const wrapper = mountPopover();
    await flushPromises();
    expect(api.list).toHaveBeenCalledWith("default", { source: "logs", limit: 50 });
    expect(rowIds(wrapper)).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
  });

  it("fetches nothing while inactive", async () => {
    mountPopover({ active: false });
    await flushPromises();
    expect(api.list).not.toHaveBeenCalled();
  });

  it("pins the latest failure with its error and Load to fix, and counts older failures", async () => {
    api.list.mockResolvedValue({
      data: [
        row(0, { status: "error", context: { error: "syntax error near level" } }),
        row(1),
        row(2, { status: "error" }),
      ],
    });
    const wrapper = mountPopover();
    await flushPromises();
    const pinned = wrapper.find('[data-test="recent-searches-pinned-failure"]');
    expect(pinned.text()).toContain("q0");
    expect(pinned.text()).toContain("syntax error near level");
    expect(rowIds(wrapper)).toEqual(["e1"]);

    await wrapper.find('[data-test="recent-searches-load-to-fix"]').trigger("click");
    expect(wrapper.emitted("load")?.[0]?.[0]).toMatchObject({ id: "e0" });

    await wrapper.find('[data-test="recent-searches-view-failed"]').trigger("click");
    expect(wrapper.emitted("view-all")?.[0]).toEqual(["error"]);
  });

  it("names the load-only key in words, matching the Shift+Enter it handles", async () => {
    api.list.mockResolvedValue({ data: [row(0)] });
    const wrapper = mountPopover();
    await flushPromises();
    const hints = wrapper.find('[data-test="recent-searches-key-hints"]').text();
    expect(hints).toContain("Shift+Enter load only");
    expect(hints).toContain("Enter run");
    expect(hints).not.toMatch(/[⇧⇥]|Tab/);
  });

  describe("the pinned failure's error line", () => {
    const message = `Search field not found: Valid fields are ${"f, ".repeat(80)}`;
    const mountWithRealTooltip = async () => {
      api.list.mockResolvedValue({
        data: [row(0, { status: "error", context: { error: message } })],
      });
      const wrapper = mount(RecentSearchesPopover, {
        props: { source: "logs", active: true },
        global: { plugins: [store], stubs: { OTimeCell: true } },
        attachTo: document.body,
      });
      await flushPromises();
      return wrapper.find('[data-test="recent-searches-pinned-error"]').element as HTMLElement;
    };
    const hover = async (el: HTMLElement) => {
      el.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(700);
      await nextTick();
      await nextTick();
    };
    const bubble = () => document.body.querySelector('[data-test="o-tooltip-content"]');

    afterEach(() => vi.useRealTimers());

    it("shows the whole message on hover when the line is cut", async () => {
      const line = await mountWithRealTooltip();
      vi.useFakeTimers();
      setWidths(line, 900, 300);
      await hover(line);
      expect(bubble()?.textContent).toContain(message.trim());
    });

    it("shows no tooltip when the message fits", async () => {
      const line = await mountWithRealTooltip();
      vi.useFakeTimers();
      setWidths(line, 300, 300);
      await hover(line);
      expect(bubble()).toBeNull();
    });
  });

  it("runs on click and only loads on shift-click", async () => {
    api.list.mockResolvedValue({ data: [row(0)] });
    const wrapper = mountPopover();
    await flushPromises();
    await wrapper.find('[data-test="recent-searches-row-e0"]').trigger("click");
    expect(wrapper.emitted("run")?.[0]).toEqual([expect.objectContaining({ id: "e0" }), "now"]);
    await wrapper.find('[data-test="recent-searches-row-e0"]').trigger("click", { shiftKey: true });
    expect(wrapper.emitted("load")?.[0]?.[0]).toMatchObject({ id: "e0" });
  });

  it("re-runs a row from an earlier day at its original time", async () => {
    api.list.mockResolvedValue({ data: [row(0, { updated_at: NOW_US - 72 * HOUR_US })] });
    const wrapper = mountPopover();
    await flushPromises();
    await wrapper.find('[data-test="recent-searches-row-e0"]').trigger("click");
    expect(wrapper.emitted("run")?.[0]?.[1]).toBe("original");
  });

  it("shows the first-time empty state with examples", async () => {
    api.list.mockResolvedValue({ data: [] });
    const wrapper = mountPopover({ examples: ["match_all('error')", "match_all('timeout')"] });
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-empty"]').exists()).toBe(true);
    await wrapper.find('[data-test="recent-searches-example-1"]').trigger("click");
    expect(wrapper.emitted("example")?.[0]).toEqual(["match_all('timeout')"]);
  });

  it("offers a retry when the list fails to load", async () => {
    api.list.mockRejectedValueOnce(new Error("down")).mockResolvedValue({ data: [row(0)] });
    const wrapper = mountPopover();
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-error"]').exists()).toBe(true);
  });
});

describe("when history is disabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.state.zoConfig.query_history_enabled = false;
  });
  afterEach(() => {
    delete store.state.zoConfig.query_history_enabled;
  });

  it("hides the clock button", () => {
    const wrapper = mount(RecentSearchesButton, {
      props: { source: "logs" },
      global: { plugins: [store] },
    });
    expect(wrapper.find('[data-test="recent-searches-btn"]').exists()).toBe(false);
  });

  it("never opens the focus dropdown and never fetches", async () => {
    const wrapper = mount(RecentSearchesFocusDropdown, {
      props: { source: "logs", anchor: null, open: true },
      global: { plugins: [store] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.querySelector('[data-test="recent-searches-focus-dropdown"]')).toBeNull();
    expect(api.list).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});

describe("keyboard: arrows then Enter or Shift+Enter", () => {
  const press = (target: Element, key: string, shiftKey = false) =>
    target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  const activeTest = () => document.activeElement?.getAttribute("data-test");

  beforeEach(() => {
    vi.clearAllMocks();
    store.state.zoConfig.query_history_enabled = true;
    api.list.mockResolvedValue({ data: [row(0), row(1)] });
  });
  afterEach(() => {
    delete store.state.zoConfig.query_history_enabled;
  });

  const openFromButton = async () => {
    const wrapper = mount(RecentSearchesButton, {
      props: { source: "logs" },
      global: { plugins: [store], stubs: { OTimeCell: true } },
      attachTo: document.body,
    });
    const trigger = wrapper.find('[data-test="recent-searches-btn"]');
    await trigger.trigger("click");
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-test="recent-searches-row-e1"]')).not.toBeNull(),
    );
    return { wrapper, trigger: trigger.element as HTMLElement };
  };

  it("loads the row Shift+Enter is pressed on, even when focus was left on the clock button", async () => {
    const { wrapper, trigger } = await openFromButton();
    trigger.focus();
    press(trigger, "ArrowDown");
    press(document.activeElement!, "ArrowDown");
    expect(activeTest()).toBe("recent-searches-row-e1");

    press(document.activeElement!, "Enter", true);
    await flushPromises();
    expect(wrapper.emitted("load")?.[0]?.[0]).toMatchObject({ id: "e1" });
    expect(wrapper.emitted("run")).toBeUndefined();
  });

  it("runs the row plain Enter is pressed on", async () => {
    const { wrapper, trigger } = await openFromButton();
    trigger.focus();
    press(trigger, "ArrowDown");
    press(document.activeElement!, "Enter");
    await flushPromises();
    expect(wrapper.emitted("run")?.[0]?.[0]).toMatchObject({ id: "e0" });
    expect(wrapper.emitted("load")).toBeUndefined();
  });

  it("loads from the editor's focus dropdown after its ArrowDown handoff", async () => {
    const wrapper = mount(RecentSearchesFocusDropdown, {
      props: { source: "logs", anchor: document.createElement("div"), open: true },
      global: { plugins: [store], stubs: { OTimeCell: true } },
      attachTo: document.body,
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-test="recent-searches-row-e0"]')).not.toBeNull(),
    );
    expect((wrapper.vm as unknown as { focusFirst: () => boolean }).focusFirst()).toBe(true);
    press(document.activeElement!, "Enter", true);
    await flushPromises();
    expect(wrapper.emitted("load")?.[0]?.[0]).toMatchObject({ id: "e0" });
  });

  const mountWithEditor = async () => {
    const box = document.createElement("div");
    const editor = document.createElement("textarea");
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter") editor.value += "\n";
    });
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    monaco.appendChild(editor);
    box.appendChild(monaco);
    document.body.appendChild(box);
    const wrapper = mount(RecentSearchesFocusDropdown, {
      props: { source: "logs", anchor: box, open: true },
      global: { plugins: [store], stubs: { OTimeCell: true } },
      attachTo: document.body,
    });
    const handle = wrapper.vm as unknown as RecentsKeyTarget;
    box.addEventListener(
      "keydown",
      (e) => routeEditorKeyToRecents(e, handle, () => wrapper.setProps({ open: false })),
      true,
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-test="recent-searches-row-e0"]')).not.toBeNull(),
    );
    editor.focus();
    return { wrapper, editor };
  };

  it("loads the first row on Shift+Enter from the editor when no row is highlighted", async () => {
    const { wrapper, editor } = await mountWithEditor();
    press(editor, "Enter", true);
    await flushPromises();
    expect(wrapper.emitted("load")?.[0]?.[0]).toMatchObject({ id: "e0" });
    expect(wrapper.emitted("run")).toBeUndefined();
    expect(editor.value).toBe("");
  });

  it("runs the first row on Enter from the editor when no row is highlighted", async () => {
    const { wrapper, editor } = await mountWithEditor();
    press(editor, "Enter");
    await flushPromises();
    expect(wrapper.emitted("run")?.[0]?.[0]).toMatchObject({ id: "e0" });
    expect(editor.value).toBe("");
  });

  it("leaves Enter to the editor when the list has no rows", async () => {
    api.list.mockResolvedValue({ data: [] });
    const box = document.createElement("div");
    const editor = document.createElement("textarea");
    editor.addEventListener("keydown", (e) => {
      if (e.key === "Enter") editor.value += "\n";
    });
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    monaco.appendChild(editor);
    box.appendChild(monaco);
    document.body.appendChild(box);
    const wrapper = mount(RecentSearchesFocusDropdown, {
      props: { source: "logs", anchor: box, open: true },
      global: { plugins: [store], stubs: { OTimeCell: true } },
      attachTo: document.body,
    });
    box.addEventListener(
      "keydown",
      (e) => routeEditorKeyToRecents(e, wrapper.vm as unknown as RecentsKeyTarget, () => {}),
      true,
    );
    await flushPromises();
    press(editor, "Enter", true);
    expect(editor.value).toBe("\n");
    expect(wrapper.emitted("load")).toBeUndefined();
  });
});
