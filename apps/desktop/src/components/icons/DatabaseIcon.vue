<script setup lang="ts">
import { computed } from "vue";
import { Database } from "@lucide/vue";
import { webPath } from "@/lib/common/webPath";

const props = defineProps<{
  dbType: string;
}>();

const assetIcons: Record<string, string> = {
  opengauss: "opengauss",
  opengauss_jdbc: "opengauss",
  gaussdb: "opengauss",
  gaussdb_m_jdbc: "opengauss",
  postgres: "postgres",
  postgresql: "postgres",
  jdbc: "postgres",
};

const normalizedType = computed(() => props.dbType.toLowerCase().replace(/[\s-]+/g, "_"));
const assetName = computed(() => assetIcons[normalizedType.value]);
const assetSrc = computed(() => {
  if (!assetName.value) return "";
  return webPath(`/icons/database/${assetName.value}.svg`);
});
</script>

<template>
  <img v-if="assetName" :src="assetSrc" alt="" class="database-logo object-contain" aria-hidden="true" />
  <Database v-else class="text-blue-400" />
</template>

<style scoped>
.database-logo {
  transform: scale(1.35);
  transform-origin: center;
}
</style>
