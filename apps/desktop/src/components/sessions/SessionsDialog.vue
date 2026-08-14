<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, XCircle } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { t } = useI18n();
const { toast } = useToast();

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

const sessions = ref<Awaited<ReturnType<typeof api.listSessions>>>([]);
const loading = ref(false);
const refreshing = ref(false);
const autoRefreshSeconds = ref(0);
const killingPid = ref<number | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    sessions.value = await api.listSessions();
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    refreshing.value = false;
    loading.value = false;
  }
}

async function kill(session: Awaited<ReturnType<typeof api.listSessions>>[number]) {
  if (!window.confirm(t("sessions.killConfirm", { pid: session.pid, user: session.username || "-" }))) return;
  killingPid.value = session.pid;
  try {
    await api.killSession(session.connection_id, session.pid);
    toast(t("sessions.killed"), 2000);
    await refresh();
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    killingPid.value = null;
  }
}

function setupTimer() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (autoRefreshSeconds.value > 0) {
    timer = setInterval(() => void refresh(), autoRefreshSeconds.value * 1000);
  }
}

watch(autoRefreshSeconds, setupTimer);
watch(dialogOpen, (open) => {
  if (open && !sessions.value.length) void refresh();
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-[820px]">
      <DialogHeader>
        <DialogTitle>{{ t("sessions.title") }}</DialogTitle>
        <DialogDescription>{{ t("sessions.description") }}</DialogDescription>
      </DialogHeader>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="refreshing" @click="refresh">
          <RefreshCw class="mr-1 h-3.5 w-3.5" :class="{ 'animate-spin': refreshing }" />
          {{ t("sessions.refresh") }}
        </Button>
        <Select v-model="autoRefreshSeconds">
          <SelectTrigger class="h-7 w-40 text-xs">
            <SelectValue :placeholder="t('sessions.autoRefresh')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="0">{{ t("sessions.autoRefreshOff") }}</SelectItem>
            <SelectItem :value="5">5s</SelectItem>
            <SelectItem :value="10">10s</SelectItem>
            <SelectItem :value="30">30s</SelectItem>
            <SelectItem :value="60">60s</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="max-h-[420px] overflow-auto rounded-md border">
        <table class="w-full text-left text-xs">
          <thead class="sticky top-0 bg-muted text-muted-foreground">
            <tr>
              <th class="px-2 py-1.5 font-medium">PID</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.user") }}</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.database") }}</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.client") }}</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.state") }}</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.started") }}</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.connection") }}</th>
              <th class="px-2 py-1.5 font-medium">{{ t("sessions.query") }}</th>
              <th class="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sessions" :key="`${session.connection_id}:${session.pid}`" class="border-t border-border/60">
              <td class="px-2 py-1.5 font-mono tabular-nums">{{ session.pid }}</td>
              <td class="px-2 py-1.5">{{ session.username || "-" }}</td>
              <td class="px-2 py-1.5">{{ session.database || "-" }}</td>
              <td class="px-2 py-1.5 font-mono text-[10px]">{{ session.client_addr || "-" }}</td>
              <td class="px-2 py-1.5">
                <span :class="session.state === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'">{{ session.state || "-" }}</span>
              </td>
              <td class="px-2 py-1.5 font-mono text-[10px]">{{ session.backend_start || "-" }}</td>
              <td class="px-2 py-1.5">{{ session.connection_name }}</td>
              <td class="max-w-[220px] truncate px-2 py-1.5 font-mono text-[10px] text-muted-foreground" :title="session.query">{{ session.query || "-" }}</td>
              <td class="px-2 py-1.5 text-right">
                <Button variant="ghost" size="icon" class="h-6 w-6 text-destructive hover:text-destructive" :disabled="killingPid === session.pid" :title="t('sessions.kill')" @click="kill(session)">
                  <XCircle class="h-3.5 w-3.5" />
                </Button>
              </td>
            </tr>
            <tr v-if="!sessions.length && !loading">
              <td colspan="9" class="px-2 py-6 text-center text-muted-foreground">{{ t("sessions.empty") }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DialogContent>
  </Dialog>
</template>
