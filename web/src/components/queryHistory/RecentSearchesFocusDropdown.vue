<!-- Copyright 2026 OpenObserve Inc.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
-->

<template>
  <Teleport to="body">
    <div
      v-if="open && enabled && placement"
      ref="panelRef"
      class="bg-dropdown-bg border-dropdown-border rounded-default fixed overflow-auto border shadow-md"
      :style="position"
      data-test="recent-searches-focus-dropdown"
    >
      <RecentSearchesPopover
        ref="listRef"
        :source="source"
        :active="open"
        :examples="examples"
        @run="(entry, when) => close(() => emit('run', entry, when))"
        @load="(entry, when) => close(() => emit('load', entry, when))"
        @view-all="(status) => close(() => emit('view-all', status))"
        @example="(query) => close(() => emit('example', query))"
        @close="close(() => emit('dismiss'))"
      />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import {
  RECENT_SEARCHES_COLUMN,
  useRecentSearches,
} from "@/composables/queryHistory/useRecentSearches";
import type { HistorySource, HistoryStatus, QueryHistoryEntry } from "@/services/query_history";
import { isQueryEditorInput, type RestoreTime } from "@/utils/queryHistory/recentSearches";
import RecentSearchesPopover from "./RecentSearchesPopover.vue";

// OPopover focuses its content on open; this panel must leave focus in the editor.
const DROPDOWN_Z_INDEX = 6000;
const EDGE_GAP_PX = 8;
const MIN_ROOM_PX = 160;
const EDITOR_INSET_PX = 40;

const props = withDefaults(
  defineProps<{
    source: HistorySource;
    /** The editor box the panel opens under. */
    anchor: HTMLElement | null;
    examples?: string[];
  }>(),
  { examples: () => [] },
);

const emit = defineEmits<{
  run: [entry: QueryHistoryEntry, when: RestoreTime];
  load: [entry: QueryHistoryEntry, when: RestoreTime];
  "view-all": [status: HistoryStatus | null];
  example: [query: string];
  dismiss: [];
}>();

const open = defineModel<boolean>("open", { default: false });

const { enabled } = useRecentSearches();
const panelRef = ref<HTMLElement | null>(null);
const listRef = ref<InstanceType<typeof RecentSearchesPopover> | null>(null);
const column = inject(RECENT_SEARCHES_COLUMN, null);
const placement = ref<{ top: number; left: number; maxWidth: number; maxHeight: number } | null>(
  null,
);

const position = computed(() => {
  const at = placement.value;
  if (!at) return { zIndex: DROPDOWN_Z_INDEX };
  return {
    top: `${at.top}px`,
    left: `${at.left}px`,
    maxWidth: `${at.maxWidth}px`,
    maxHeight: `${at.maxHeight}px`,
    zIndex: DROPDOWN_Z_INDEX,
  };
});

const place = () => {
  const box = props.anchor?.getBoundingClientRect();
  if (!box) return null;
  const paneRect = column?.pane.value?.getBoundingClientRect();
  const paneShown = !!paneRect && paneRect.width > 0;
  if (column && !paneShown) return null;
  const pane = paneShown ? paneRect : box;
  const left = Math.max(box.left, pane.left) + EDGE_GAP_PX;
  const right = Math.min(box.right, pane.right, window.innerWidth) - EDGE_GAP_PX;
  const maxWidth = Math.max(right - left, 0);
  const underEditor = box.bottom + 2;
  const roomUnder = window.innerHeight - underEditor - EDGE_GAP_PX;
  if (roomUnder >= MIN_ROOM_PX) return { top: underEditor, left, maxWidth, maxHeight: roomUnder };
  if (column) return null;
  const inEditor = box.top + EDITOR_INSET_PX;
  const roomInEditor = Math.min(box.bottom, window.innerHeight) - inEditor - EDGE_GAP_PX;
  if (roomInEditor < MIN_ROOM_PX) return null;
  return { top: inEditor, left, maxWidth, maxHeight: roomInEditor };
};

const placeRevealingEditor = () => {
  const at = place();
  if (at || column || !props.anchor?.scrollIntoView) return at;
  props.anchor.scrollIntoView({ block: "nearest" });
  return place();
};

const close = (then: () => void) => {
  open.value = false;
  then();
};

// Only the editor's text surface keeps the panel open; the AI prompt and buttons in the same box do not.
const onOutside = (event: Event) => {
  const target = event.target as Node | null;
  if (target && panelRef.value?.contains(target)) return;
  if (target && props.anchor?.contains(target) && isQueryEditorInput(target)) return;
  open.value = false;
};

const listen = (on: boolean) => {
  const method = on ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", onOutside, true);
  document[method]("focusin", onOutside, true);
  // Pages also dispatch synthetic resizes to re-lay charts (Metrics after an edit), so re-place rather than close.
  window[method]("resize", followLayout);
  document[method]("scroll", onScroll, true);
};

const placedAgainst = computed(() =>
  [props.anchor, column?.pane.value].filter((el): el is HTMLElement => !!el),
);

let resizeObserver: ResizeObserver | null = null;
let placedAnchor = "";
let followFrame = 0;

const anchorKey = () => {
  const box = props.anchor?.getBoundingClientRect();
  return box ? `${box.left}|${box.top}|${box.right}|${box.bottom}` : "";
};

// A layout shift re-places the panel like a focus does; only a user's scroll may take the editor away.
const reposition = (reveal: boolean) => {
  if (!open.value) return;
  placement.value = reveal ? placeRevealingEditor() : place();
  placedAnchor = anchorKey();
  if (!placement.value) open.value = false;
};

const followLayout = () => reposition(true);

// The editor can move without resizing (a chart above it renders), which no observer reports.
const followAnchor = () => {
  if (!open.value) return;
  if (anchorKey() !== placedAnchor) followLayout();
  followFrame = requestAnimationFrame(followAnchor);
};

const stopFollowing = () => {
  if (followFrame) cancelAnimationFrame(followFrame);
  followFrame = 0;
};

const onScroll = (event: Event) => {
  const target = event.target;
  if (!(target instanceof Node) || !props.anchor || !target.contains(props.anchor)) return;
  reposition(false);
};

const observe = (elements: HTMLElement[]) => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (!elements.length || typeof ResizeObserver === "undefined") return;
  resizeObserver = new ResizeObserver(followLayout);
  elements.forEach((el) => resizeObserver?.observe(el, { box: "border-box" }));
};

watch(
  open,
  (isOpen) => {
    stopFollowing();
    placement.value = isOpen ? placeRevealingEditor() : null;
    if (isOpen && !placement.value) {
      open.value = false;
      return;
    }
    listen(isOpen);
    observe(isOpen ? placedAgainst.value : []);
    if (!isOpen || typeof requestAnimationFrame !== "function") return;
    placedAnchor = anchorKey();
    followFrame = requestAnimationFrame(followAnchor);
  },
  { immediate: true },
);

// The anchor arrives with the editor's focus; the open watcher does the first placement.
watch(placedAgainst, (elements) => {
  if (!open.value || !placement.value) return;
  observe(elements);
  followLayout();
});

onBeforeUnmount(() => {
  stopFollowing();
  listen(false);
  observe([]);
});

/** Moves focus from the editor into the list; false when there is no row to focus. */
const focusFirst = () => listRef.value?.focusFirst() ?? false;

/** Runs, or with Shift loads, the first row while focus is still in the editor. */
const pickFirst = (event: KeyboardEvent) => listRef.value?.pickFirst(event) ?? false;

defineExpose({ focusFirst, pickFirst });
</script>
