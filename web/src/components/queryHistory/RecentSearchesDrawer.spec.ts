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

const clipboard = vi.hoisted(() => ({ copyToClipboard: vi.fn() }));
vi.mock("@/utils/clipboard", () => clipboard);

const push = vi.hoisted(() => vi.fn());
vi.mock("vue-router", () => ({
  useRouter: () => ({
    push,
    resolve: (to: { path: string; query: Record<string, string> }) => ({
      href: `/web${to.path}?${new URLSearchParams(to.query).toString()}`,
    }),
  }),
}));

import RecentSearchesDrawer from "./RecentSearchesDrawer.vue";
import { dismissAll, pauseTimer, toastRecords } from "@/lib/feedback/Toast/useToast";

enableAutoUnmount(afterEach);

const NOW_US = Date.now() * 1000;
const DAY_US = 86_400_000_000;

const row = (id: string, overrides: Partial<QueryHistoryEntry> = {}): QueryHistoryEntry => ({
  id,
  source: "logs",
  query: `query ${id}`,
  query_key: "k",
  streams: ["k8s"],
  context: { time: { type: "relative", period: "15m", start_time: 1, end_time: 2 } },
  status: "ok",
  starred: false,
  run_count: 1,
  created_at: NOW_US,
  updated_at: NOW_US,
  ...overrides,
});

const input = (name: string) => ({
  props: ["modelValue"],
  emits: ["update:modelValue"],
  template: `<input data-stub="${name}" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
});

const mountDrawer = () =>
  mount(RecentSearchesDrawer, {
    props: { source: "logs", open: true },
    global: {
      plugins: [store],
      stubs: {
        ODrawer: {
          props: ["open"],
          template: `<div v-if="open"><slot /><slot name="footer" /></div>`,
        },
        ODialog: {
          props: ["open"],
          emits: ["click:primary", "click:secondary"],
          template: `<div v-if="open" data-test="dialog"><slot />
            <button data-test="dialog-confirm" @click="$emit('click:primary')" /></div>`,
        },
        // The real menu is portalled, so its clicks never reach the row.
        ODropdown: { template: `<div @click.stop><slot name="trigger" /><slot /></div>` },
        ODropdownItem: {
          emits: ["select"],
          template: `<button v-bind="$attrs" @click="$emit('select')"><slot /></button>`,
        },
        OSearchInput: input("search"),
        OSelect: input("select"),
        ODate: input("date"),
        OSwitch: {
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template: `<input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)" />`,
        },
        OCheckbox: {
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template: `<input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)" />`,
        },
        OToggleGroup: {
          props: ["modelValue"],
          emits: ["update:modelValue"],
          template: `<div><button data-test="scope-all" @click="$emit('update:modelValue', 'all')" /><slot /></div>`,
        },
        OToggleGroupItem: { template: "<span><slot /></span>" },
        OTimeCell: true,
        OTooltip: true,
      },
    },
  });

const lastParams = () => api.list.mock.calls.at(-1)?.[1];

describe("RecentSearchesDrawer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({
      data: [row("today"), row("old", { updated_at: NOW_US - 3 * DAY_US, run_count: 4 })],
    });
    api.star.mockResolvedValue({ data: {} });
    api.remove.mockResolvedValue({ data: {} });
    api.clear.mockResolvedValue({ data: { deleted: 2 } });
  });
  afterEach(() => {
    store.state.zoConfig.query_history_retention_days = undefined;
  });

  it("lists this page's rows grouped by day", async () => {
    const wrapper = mountDrawer();
    await flushPromises();
    expect(lastParams()).toEqual({ source: "logs", limit: 50, offset: 0 });
    const days = wrapper.findAll('[data-test="recent-searches-day"]');
    expect(days).toHaveLength(2);
    expect(days[0].text()).toContain("Today");
    expect(days[1].text()).toContain("ran 4x");
  });

  it("sends every filter to the server", async () => {
    const wrapper = mountDrawer();
    await flushPromises();
    await wrapper.find('[data-stub="search"]').setValue("checkout");
    const selects = wrapper.findAll('[data-stub="select"]');
    await selects[0].setValue("k8s");
    await selects[1].setValue("error");
    await wrapper.find('[data-stub="date"]').setValue("2026-10-27");
    await wrapper.find('[data-test="recent-searches-starred-only"]').setValue(true);
    await flushPromises();
    const bounds = {
      ran_from: new Date(2026, 9, 27).getTime() * 1000,
      ran_to: new Date(2026, 9, 28).getTime() * 1000 - 1,
    };
    expect(lastParams()).toEqual({
      source: "logs",
      q: "checkout",
      stream: "k8s",
      status: "error",
      starred: true,
      ...bounds,
      limit: 50,
      offset: 0,
    });

    await wrapper.find('[data-test="scope-all"]').trigger("click");
    await flushPromises();
    expect(lastParams().source).toBeUndefined();
  });

  it("re-runs now on a row click from today, and at original time on demand", async () => {
    const wrapper = mountDrawer();
    await flushPromises();
    await wrapper.find('[data-test="recent-searches-drawer-row-today"]').trigger("click");
    expect(wrapper.emitted("restore")?.[0]).toEqual([
      expect.objectContaining({ id: "today" }),
      "now",
      true,
    ]);
    expect(wrapper.emitted("update:open")?.at(-1)).toEqual([false]);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await wrapper.find('[data-test="recent-searches-rerun-original-old"]').trigger("click");
    expect(wrapper.emitted("restore")?.[1]?.slice(1)).toEqual(["original", true]);
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await wrapper.find('[data-test="recent-searches-load-old"]').trigger("click");
    expect(wrapper.emitted("restore")?.[2]?.slice(1)).toEqual(["original", false]);
  });

  it("stars, deletes and copies without restoring", async () => {
    const wrapper = mountDrawer();
    await flushPromises();
    await wrapper.find('[data-test="recent-searches-star-today"]').trigger("click");
    await flushPromises();
    expect(api.star).toHaveBeenCalledWith("default", "today", true);
    await wrapper.find('[data-test="recent-searches-copy-query-old"]').trigger("click");
    expect(clipboard.copyToClipboard).toHaveBeenLastCalledWith(
      "query old",
      expect.any(Function),
      expect.any(Object),
    );
    await wrapper.find('[data-test="recent-searches-copy-link-today"]').trigger("click");
    const link = clipboard.copyToClipboard.mock.calls.at(-1)?.[0] as string;
    expect(link).toContain("/web/logs?");
    expect(link).toContain("from=1");
    expect(link).toContain("to=2");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await wrapper.find('[data-test="recent-searches-delete-old"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-test="recent-searches-drawer-row-old"]').exists()).toBe(false);
      expect(api.remove).not.toHaveBeenCalled();
      vi.advanceTimersByTime(6000);
      await flushPromises();
      expect(api.remove).toHaveBeenCalledWith("default", "old");
    } finally {
      vi.useRealTimers();
    }
    expect(wrapper.emitted("restore")).toBeUndefined();
  });

  describe("delete with Undo", () => {
    const deleteToast = () => toastRecords.find((r) => r.message.startsWith("Deleted"));
    const rowShown = (wrapper: ReturnType<typeof mountDrawer>) =>
      wrapper.find('[data-test="recent-searches-drawer-row-old"]').exists();
    const deleteOld = async (wrapper: ReturnType<typeof mountDrawer>) => {
      await wrapper.find('[data-test="recent-searches-delete-old"]').trigger("click");
      await flushPromises();
    };

    beforeEach(() => {
      dismissAll();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
      dismissAll();
    });

    it("brings the row back on Undo and never deletes it", async () => {
      const wrapper = mountDrawer();
      await flushPromises();
      await deleteOld(wrapper);
      expect(rowShown(wrapper)).toBe(false);
      expect(deleteToast()?.message).toBe("Deleted query old");

      deleteToast()?.action?.handler();
      await flushPromises();
      expect(rowShown(wrapper)).toBe(true);
      expect(deleteToast()?.open ?? false).toBe(false);
      vi.advanceTimersByTime(20000);
      await flushPromises();
      expect(api.remove).not.toHaveBeenCalled();
    });

    it("deletes only when the toast closes, so a paused toast keeps Undo working", async () => {
      const wrapper = mountDrawer();
      await flushPromises();
      await deleteOld(wrapper);
      const record = deleteToast();
      pauseTimer(record!.id);
      vi.advanceTimersByTime(20000);
      await flushPromises();
      expect(api.remove).not.toHaveBeenCalled();

      record?.action?.handler();
      await flushPromises();
      expect(rowShown(wrapper)).toBe(true);
      expect(api.remove).not.toHaveBeenCalled();
    });

    it("deletes once the toast times out, and Undo then does nothing", async () => {
      const wrapper = mountDrawer();
      await flushPromises();
      await deleteOld(wrapper);
      const action = deleteToast()?.action;
      vi.advanceTimersByTime(6000);
      await flushPromises();
      expect(api.remove).toHaveBeenCalledWith("default", "old");

      action?.handler();
      await flushPromises();
      expect(rowShown(wrapper)).toBe(false);
      expect(api.remove).toHaveBeenCalledTimes(1);
    });

    it("closes the toast before committing when the drawer goes away", async () => {
      const wrapper = mountDrawer();
      await flushPromises();
      await deleteOld(wrapper);
      const record = deleteToast();
      wrapper.unmount();
      await flushPromises();
      expect(api.remove).toHaveBeenCalledWith("default", "old");
      expect(record?.open).toBe(false);
    });
  });

  it("unstars the row that carries a star shared by another day's row", async () => {
    api.list.mockResolvedValue({
      data: [
        row("today", { query: "same" }),
        row("monday", { query: "same", starred: true, updated_at: NOW_US - 3 * DAY_US }),
      ],
    });
    const wrapper = mountDrawer();
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-star-today"]').attributes("aria-label")).toBe(
      "Unstar",
    );
    await wrapper.find('[data-test="recent-searches-star-today"]').trigger("click");
    await flushPromises();
    expect(api.star).toHaveBeenCalledWith("default", "monday", false);
  });

  it("clears this page and keeps starred by default, all pages and starred on request", async () => {
    const wrapper = mountDrawer();
    await flushPromises();
    await wrapper.find('[data-test="recent-searches-clear-btn"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-clear-body"]').text()).toContain(
      "recent Logs searches",
    );
    await wrapper.find('[data-test="dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(api.clear).toHaveBeenLastCalledWith("default", {
      source: "logs",
      include_starred: false,
    });

    await wrapper.find('[data-test="scope-all"]').trigger("click");
    await wrapper.find('[data-test="recent-searches-clear-btn"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-clear-body"]').text()).toContain(
      "across Logs, Traces and Metrics",
    );
    await wrapper.find('[data-test="recent-searches-clear-include-starred"]').setValue(true);
    await wrapper.find('[data-test="dialog-confirm"]').trigger("click");
    await flushPromises();
    expect(api.clear).toHaveBeenLastCalledWith("default", { include_starred: true });
  });

  it("shows the retention from /config, or kept until deleted", async () => {
    store.state.zoConfig.query_history_retention_days = 30;
    const wrapper = mountDrawer();
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-retention"]').text()).toContain(
      "Kept 30 days",
    );
    store.state.zoConfig.query_history_retention_days = 0;
    await flushPromises();
    expect(wrapper.find('[data-test="recent-searches-retention"]').text()).toContain(
      "Kept until deleted",
    );
  });
});

describe("Starred only (real checkbox)", () => {
  const ROWS = [row("today"), row("starred", { starred: true }), row("other")];

  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockImplementation((_org: string, params: { starred?: boolean }) =>
      Promise.resolve({ data: params.starred ? ROWS.filter((r) => r.starred) : ROWS }),
    );
  });

  const mountWithRealCheckbox = () =>
    mount(RecentSearchesDrawer, {
      props: { source: "logs", open: true },
      global: {
        plugins: [store],
        stubs: {
          ODrawer: {
            props: ["open"],
            template: `<div v-if="open"><slot /><slot name="footer" /></div>`,
          },
          ODialog: true,
          OTimeCell: true,
          OTooltip: true,
        },
      },
    });
  const shownRows = (wrapper: ReturnType<typeof mountWithRealCheckbox>) =>
    wrapper.findAll('[data-test^="recent-searches-drawer-row-"]').length;
  const box = (wrapper: ReturnType<typeof mountWithRealCheckbox>) =>
    wrapper.find('[data-test="recent-searches-starred-only"] [role="checkbox"]');

  it("shows a checked box and only starred rows, also after the drawer is closed and reopened", async () => {
    const wrapper = mountWithRealCheckbox();
    await flushPromises();
    expect(shownRows(wrapper)).toBe(3);
    expect(box(wrapper).attributes("aria-checked")).toBe("false");

    await box(wrapper).trigger("click");
    await flushPromises();
    expect(box(wrapper).attributes("aria-checked")).toBe("true");
    expect(api.list).toHaveBeenLastCalledWith(
      "default",
      expect.objectContaining({ starred: true }),
    );
    expect(shownRows(wrapper)).toBe(1);

    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();
    expect(box(wrapper).attributes("aria-checked")).toBe("true");
    expect(shownRows(wrapper)).toBe(1);

    await box(wrapper).trigger("click");
    await flushPromises();
    expect(box(wrapper).attributes("aria-checked")).toBe("false");
    expect(shownRows(wrapper)).toBe(3);
  });

  it("shows a failed row's whole error on hover only when the line is cut", async () => {
    const message = `Search field not found: ${"x".repeat(300)}`;
    api.list.mockResolvedValue({
      data: [row("bad", { status: "error", context: { error: message } })],
    });
    const wrapper = mount(RecentSearchesDrawer, {
      props: { source: "logs", open: true },
      global: {
        plugins: [store],
        stubs: {
          ODrawer: { props: ["open"], template: `<div v-if="open"><slot /></div>` },
          ODialog: true,
          OTimeCell: true,
        },
      },
      attachTo: document.body,
    });
    await flushPromises();
    const line = wrapper.find('[data-test="recent-searches-drawer-error"]').element;
    const hover = async () => {
      line.dispatchEvent(new MouseEvent("mouseleave"));
      await nextTick();
      line.dispatchEvent(new MouseEvent("mouseenter"));
      vi.advanceTimersByTime(700);
      await nextTick();
      await nextTick();
    };
    const bubble = () => document.body.querySelector('[data-test="o-tooltip-content"]');
    const setWidths = (scrollWidth: number, clientWidth: number) => {
      Object.defineProperty(line, "scrollWidth", { configurable: true, value: scrollWidth });
      Object.defineProperty(line, "clientWidth", { configurable: true, value: clientWidth });
    };
    vi.useFakeTimers();
    try {
      setWidths(300, 300);
      await hover();
      expect(bubble()).toBeNull();
      setWidths(1200, 300);
      await hover();
      expect(bubble()?.textContent).toContain(message);
    } finally {
      vi.useRealTimers();
      wrapper.unmount();
    }
  });
});
