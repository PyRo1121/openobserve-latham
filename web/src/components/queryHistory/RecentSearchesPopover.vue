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
  <div
    ref="rootRef"
    class="flex w-[min(46rem,calc(100vw-2rem))] max-w-full flex-col"
    data-test="recent-searches-popover"
    @keydown="onKeydown"
  >
    <div
      class="border-border-subtle text-dropdown-label flex items-center gap-2 border-b px-3 py-1.5 text-xs font-semibold uppercase"
    >
      <OIcon name="history" size="sm" />
      <span>{{ t(`recentSearches.pageTitle.${source}`) }}</span>
    </div>

    <OEmptyState
      v-if="list.isError.value"
      size="inline"
      icon="error"
      :title="t('recentSearches.loadError')"
      :action-label="t('recentSearches.retry')"
      action-icon="refresh"
      data-test="recent-searches-error"
      @action="list.refetch()"
    />
    <div v-else-if="list.isPending.value" class="flex flex-col gap-2 p-3">
      <OSkeleton v-for="n in 4" :key="n" type="text" />
    </div>
    <div v-else-if="isEmpty" class="flex flex-col items-center gap-2 p-4">
      <OEmptyState
        size="inline"
        icon="history"
        :title="t('recentSearches.emptyTitle')"
        :description="t('recentSearches.emptyDescription', { days: retentionDays })"
        data-test="recent-searches-empty"
      />
      <div v-if="examples.length" class="flex flex-wrap justify-center gap-2">
        <OButton
          v-for="(example, index) in examples"
          :key="index"
          variant="outline"
          size="xs"
          icon-left="lightbulb"
          :data-test="`recent-searches-example-${index}`"
          @click="emit('example', example)"
        >
          <OTruncatedText class="max-w-60 font-mono">{{ example }}</OTruncatedText>
        </OButton>
      </div>
    </div>
    <div
      v-else
      role="listbox"
      :aria-label="t('recentSearches.title')"
      class="max-h-[23rem] overflow-auto py-1"
      data-test="recent-searches-list"
    >
      <div
        v-if="view.pinnedFailure"
        class="hover:bg-dropdown-item-hover-bg flex items-start gap-2 px-3 py-1.5"
        data-test="recent-searches-pinned-failure"
      >
        <button
          type="button"
          role="option"
          data-recent-row
          class="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-left outline-none"
          @click="pick(view.pinnedFailure.entry, $event, true)"
          @keydown.enter.prevent="pick(view.pinnedFailure.entry, $event, true)"
        >
          <span class="flex w-full min-w-0 items-center gap-2">
            <OIcon name="error" size="sm" class="text-status-error-text shrink-0" />
            <OTruncatedText class="text-text-heading font-mono text-xs">
              {{ oneLine(view.pinnedFailure.entry.query) }}
            </OTruncatedText>
          </span>
          <OTruncatedText
            v-if="view.pinnedFailure.entry.context.error"
            :tooltip="raw(view.pinnedFailure.entry.context.error)"
            class="text-status-error-text w-full ps-6 text-xs"
            data-test="recent-searches-pinned-error"
          >
            {{ view.pinnedFailure.entry.context.error }}
          </OTruncatedText>
        </button>
        <OButton
          variant="outline"
          size="xs"
          data-test="recent-searches-load-to-fix"
          @click="emit('load', view.pinnedFailure.entry, 'original')"
        >
          {{ t("recentSearches.loadToFix") }}
        </OButton>
      </div>
      <button
        v-for="row in view.rows"
        :key="row.entry.id"
        type="button"
        role="option"
        data-recent-row
        class="hover:bg-dropdown-item-hover-bg focus-visible:bg-dropdown-item-hover-bg flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left outline-none"
        :data-test="`recent-searches-row-${row.entry.id}`"
        @click="pick(row.entry, $event, false)"
        @keydown.enter.prevent="pick(row.entry, $event, false)"
      >
        <OIcon
          :name="row.starred ? 'star' : 'history'"
          size="sm"
          class="shrink-0"
          :class="row.starred ? 'text-accent' : 'text-text-secondary'"
        />
        <OTag
          v-for="stream in row.entry.streams.slice(0, 2)"
          :key="stream"
          :label="raw(stream)"
          size="sm"
          class="shrink-0"
        />
        <OTruncatedText class="text-text-heading flex-1 font-mono text-xs">
          {{ oneLine(row.entry.query) }}
        </OTruncatedText>
        <span
          v-if="row.entry.context.warning !== undefined"
          class="bg-status-warning-text size-2 shrink-0 rounded-full"
          data-test="recent-searches-warning-dot"
        >
          <OTooltip :content="t('recentSearches.warning')" />
        </span>
        <OTimeCell
          :value="row.entry.updated_at"
          unit="us"
          mode="relative"
          class="text-text-secondary shrink-0 text-xs"
        />
      </button>
    </div>

    <div
      class="border-border-subtle bg-surface-panel text-text-secondary flex items-center justify-between gap-2 border-t px-3 py-1 text-xs"
    >
      <div class="flex items-center gap-1">
        <OButton
          variant="ghost-primary"
          size="xs"
          icon-left="history"
          data-test="recent-searches-view-all"
          @click="emit('view-all', null)"
        >
          {{ t("recentSearches.viewAll") }}
        </OButton>
        <OButton
          v-if="view.failedCount > 0"
          variant="ghost-muted"
          size="xs"
          data-test="recent-searches-view-failed"
          @click="emit('view-all', 'error')"
        >
          {{ t("recentSearches.failedCount", { count: view.failedCount }) }}
        </OButton>
      </div>
      <span class="max-md:hidden" data-test="recent-searches-key-hints">{{
        t("recentSearches.keyHints")
      }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, toRef } from "vue";
import { raw, useI18nTyped } from "@/types/i18n";
import {
  useRecentSearches,
  useRecentSearchesList,
} from "@/composables/queryHistory/useRecentSearches";
import {
  buildRecents,
  defaultRestoreTime,
  type RestoreTime,
} from "@/utils/queryHistory/recentSearches";
import type { HistorySource, HistoryStatus, QueryHistoryEntry } from "@/services/query_history";
import OButton from "@/lib/core/Button/OButton.vue";
import OIcon from "@/lib/core/Icon/OIcon.vue";
import OTag from "@/lib/core/Badge/OTag.vue";
import OEmptyState from "@/lib/core/EmptyState/OEmptyState.vue";
import OSkeleton from "@/lib/feedback/Skeleton/OSkeleton.vue";
import OTimeCell from "@/lib/core/Table/cells/OTimeCell.vue";
import OTooltip from "@/lib/overlay/Tooltip/OTooltip.vue";
import OTruncatedText from "@/lib/core/Typography/OTruncatedText.vue";

const props = withDefaults(
  defineProps<{
    source: HistorySource;
    /** Fetches while true, so a closed popover costs nothing. */
    active: boolean;
    /** Example queries for the first-time empty state. */
    examples?: string[];
  }>(),
  { examples: () => [] },
);

const emit = defineEmits<{
  run: [entry: QueryHistoryEntry, when: RestoreTime];
  load: [entry: QueryHistoryEntry, when: RestoreTime];
  "view-all": [status: HistoryStatus | null];
  example: [query: string];
  close: [];
}>();

const { t } = useI18nTyped();
const { retentionDays } = useRecentSearches();
const list = useRecentSearchesList(props.source, toRef(props, "active"));
const rootRef = ref<HTMLElement | null>(null);

const view = computed(() => buildRecents(list.data.value ?? []));
const isEmpty = computed(() => !view.value.pinnedFailure && view.value.rows.length === 0);

const oneLine = (query: string) => query.replace(/\s+/g, " ").trim();

// Shift loads without running; a failed row always loads, since running it again fails again.
const pick = (entry: QueryHistoryEntry, event: MouseEvent | KeyboardEvent, failed: boolean) => {
  const when = defaultRestoreTime(entry);
  if (failed || event.shiftKey) emit("load", entry, when);
  else emit("run", entry, when);
};

const rows = () => [...(rootRef.value?.querySelectorAll<HTMLElement>("[data-recent-row]") ?? [])];

const moveFocus = (step: number) => {
  const all = rows();
  if (!all.length) return;
  const at = all.indexOf(document.activeElement as HTMLElement);
  const next = at < 0 ? (step > 0 ? 0 : all.length - 1) : (at + step + all.length) % all.length;
  all[next].focus();
};

const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveFocus(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
};

/** Moves keyboard focus into the list, for the editor's ArrowDown handoff. */
const focusFirst = () => {
  const first = rows()[0];
  if (!first) return false;
  first.focus();
  return true;
};

/** Runs, or with Shift loads, the first row, as Enter would on it; false when the list is empty. */
const pickFirst = (event: KeyboardEvent) => {
  const first = view.value.pinnedFailure ?? view.value.rows[0];
  if (!first) return false;
  pick(first.entry, event, first === view.value.pinnedFailure);
  return true;
};

/** Handles a key pressed while focus is still outside the list; true when it was used. */
const handleOutsideKey = (event: KeyboardEvent) => {
  if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) return false;
  onKeydown(event);
  return true;
};

defineExpose({ focusFirst, pickFirst, handleOutsideKey });
</script>
