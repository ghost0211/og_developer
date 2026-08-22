<script setup lang="ts">
import { computed } from "vue";
import { Bug } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import RoutineDebugPanel from "@/components/debug/RoutineDebugPanel.vue";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
  kind?: string;
  routineName: string;
  signature?: string;
  callSql?: string;
}>();

const targetLabel = computed(() => `${props.schema ? `${props.schema}.` : ""}${props.routineName}`);

const handleOpenChange = (next: boolean) => {
  open.value = next;
};
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="flex h-[88vh] max-h-[92vh] w-[95vw] sm:max-w-[1280px] flex-col p-0 gap-0 border border-border !bg-background text-foreground shadow-2xl overflow-hidden">
      <DialogHeader class="px-4 py-2 border-b bg-muted/30 flex flex-row items-center justify-between space-y-0 shrink-0">
        <DialogTitle class="flex items-center gap-2 text-sm font-medium">
          <Bug class="h-4 w-4 text-amber-500" />
          <span class="truncate">{{ t("plDebug.title", { name: targetLabel }) }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-hidden">
        <RoutineDebugPanel v-if="open" :connection-id="props.connectionId" :database="props.database" :schema="props.schema" :routine-name="props.routineName" :routine-kind="(props.kind as any) || 'procedure'" :signature="props.signature" :call-sql="props.callSql" @close="open = false" />
      </div>
    </DialogContent>
  </Dialog>
</template>
