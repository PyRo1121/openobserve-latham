<script setup lang="ts">
import { computed } from "vue";
import { useStore } from "vuex";

const store = useStore();
const iframeSrc = computed(() => {
  const endpoint = String(store.state.API_ENDPOINT ?? "").replace(/\/+$/, "");
  const theme = store.state.theme === "dark" ? "dark" : "light";
  return `${endpoint}/_observatory/visitors?embedded=1&theme=${theme}`;
});
</script>

<template>
  <iframe
    :src="iframeSrc"
    title="Website traffic"
    loading="eager"
    class="h-full min-h-0 w-full border-0"
  />
</template>
