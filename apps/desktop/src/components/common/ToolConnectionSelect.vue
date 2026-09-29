<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { toolConnections, type ToolConnectionKind } from "@/lib/database/toolTargets";

const props = defineProps<{
  modelValue: string;
  kind: ToolConnectionKind;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [connectionId: string];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();

const options = computed(() => toolConnections(connectionStore.connections, props.kind));

function titleFor(connectionId: string): string {
  const connection = options.value.find((candidate) => candidate.id === connectionId);
  if (!connection) return connectionId;
  const endpoint = connection.host ? `${connection.host}${connection.port ? `:${connection.port}` : ""}` : "";
  return [connection.name, connection.username && endpoint ? `${connection.username}@${endpoint}` : endpoint].filter(Boolean).join(" · ");
}

function onChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value && value !== props.modelValue) emit("update:modelValue", value);
}
</script>

<template>
  <select :value="modelValue" class="h-6 max-w-[200px] rounded border bg-background px-1.5 text-xs font-normal outline-none focus:border-ring" :aria-label="t('editor.selectConnection')" :disabled="disabled || options.length === 0" data-testid="tool-connection-select" @change="onChange">
    <option v-if="!modelValue" value="" disabled>{{ t("editor.selectConnection") }}</option>
    <option v-for="connection in options" :key="connection.id" :value="connection.id" :title="titleFor(connection.id)">{{ connection.name }}</option>
    <option v-if="modelValue && !options.some((connection) => connection.id === modelValue)" :value="modelValue">{{ modelValue }}</option>
  </select>
</template>
