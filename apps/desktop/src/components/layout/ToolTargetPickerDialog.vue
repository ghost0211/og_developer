<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import * as api from "@/lib/backend/api";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { useConnectionStore } from "@/stores/connectionStore";

export type ToolTargetKind = "processlist" | "routine-health" | "top-sql" | "command-window" | "table-import";

export interface ToolTarget {
  kind: ToolTargetKind;
  connectionId: string;
  database?: string;
}

const props = defineProps<{
  open: boolean;
  kind: ToolTargetKind;
  initialConnectionId?: string;
  initialDatabase?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [target: ToolTarget];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const selectedConnectionId = ref("");
const selectedDatabase = ref("");
const databases = ref<string[]>([]);
const loading = ref(false);
const loadError = ref("");
let loadGeneration = 0;
let initialDatabaseConnectionId = "";
let disposed = false;

const needsDatabase = computed(() => props.kind !== "processlist");
const eligibleConnections = computed(() =>
  connectionStore.connections.filter((connection) => {
    const type = effectiveDatabaseTypeForConnection(connection);
    if (props.kind === "command-window") return supportsDatabaseFeature(type, "queryExecution");
    if (props.kind === "table-import") return supportsDatabaseFeature(type, "tableImport");
    return type === "postgres" || type === "opengauss";
  }),
);
const eligibleConnectionIds = computed(() => eligibleConnections.value.map((connection) => connection.id).join("\u001f"));
const canConfirm = computed(() => {
  if (!props.open || loading.value || loadError.value || !eligibleConnections.value.some((connection) => connection.id === selectedConnectionId.value)) return false;
  return !needsDatabase.value || (!!selectedDatabase.value && databases.value.includes(selectedDatabase.value));
});
const titleKey: Record<ToolTargetKind, string> = {
  processlist: "toolTargetPicker.title.processlist",
  "routine-health": "toolTargetPicker.title.routineHealth",
  "top-sql": "toolTargetPicker.title.topSql",
  "command-window": "toolTargetPicker.title.commandWindow",
  "table-import": "toolTargetPicker.title.tableImport",
};
const descriptionKey: Record<ToolTargetKind, string> = {
  processlist: "toolTargetPicker.description.processlist",
  "routine-health": "toolTargetPicker.description.routineHealth",
  "top-sql": "toolTargetPicker.description.topSql",
  "command-window": "toolTargetPicker.description.commandWindow",
  "table-import": "toolTargetPicker.description.tableImport",
};
const connectionSelectOptions = computed(() => eligibleConnections.value.map((connection) => connection.id));
const databaseSelectOptions = computed(() => databases.value.filter(Boolean));

function titleForConnection(connectionId: string): string {
  const connection = eligibleConnections.value.find((candidate) => candidate.id === connectionId);
  if (!connection) return connectionId;
  const endpoint = [connection.username, connection.host && `${connection.host}${connection.port ? `:${connection.port}` : ""}`].filter(Boolean).join("@");
  return endpoint ? `${connection.name} · ${endpoint}` : connection.name;
}

function initialConnectionCandidate(): string {
  const eligible = eligibleConnections.value;
  const requested = eligible.find((connection) => connection.id === props.initialConnectionId);
  if (requested) return requested.id;
  const active = eligible.find((connection) => connection.id === connectionStore.activeConnectionId);
  return active?.id || eligible[0]?.id || "";
}

function clearTargetState() {
  selectedConnectionId.value = "";
  selectedDatabase.value = "";
  databases.value = [];
  loading.value = false;
  loadError.value = "";
}

function resetForClosedDialog() {
  loadGeneration++;
  initialDatabaseConnectionId = "";
  clearTargetState();
}

async function prepareConnection(connectionId: string) {
  const request = ++loadGeneration;
  selectedDatabase.value = "";
  databases.value = [];
  loadError.value = "";
  if (!connectionId) {
    loading.value = false;
    return;
  }

  const config = connectionStore.getConfig(connectionId);
  if (!config || !eligibleConnections.value.some((connection) => connection.id === connectionId)) {
    loading.value = false;
    loadError.value = t("toolTargetPicker.connectionUnavailable");
    return;
  }

  loading.value = true;
  try {
    await connectionStore.ensureConnected(connectionId, { activate: false });
    if (disposed || request !== loadGeneration || !props.open || selectedConnectionId.value !== connectionId) return;

    // The process list is instance-scoped: connect/validate the target, but do
    // not fetch or require any database selection for it.
    if (needsDatabase.value) {
      const rows = await api.listDatabases(connectionId);
      if (disposed || request !== loadGeneration || !props.open || selectedConnectionId.value !== connectionId) return;

      const currentConfig = connectionStore.getConfig(connectionId) ?? config;
      databases.value = databaseOptionsForConnection(
        rows.map((database) => database.name),
        currentConfig,
      ).filter(Boolean);
      // Some drivers have a configured default database but do not enumerate
      // databases. Preserve that target instead of blocking the menu entry.
      if (!databases.value.length && currentConfig.database?.trim()) {
        databases.value = databaseOptionsForConnection([currentConfig.database.trim()], currentConfig).filter(Boolean);
      }

      const initialDatabase = initialDatabaseConnectionId === connectionId ? props.initialDatabase : undefined;
      const candidates = [initialDatabase, currentConfig.database, databases.value[0]];
      selectedDatabase.value = candidates.find((candidate) => !!candidate && databases.value.includes(candidate)) ?? "";
    }
  } catch (error) {
    if (!disposed && request === loadGeneration && props.open && selectedConnectionId.value === connectionId) {
      const message = error instanceof Error ? error.message : String(error);
      loadError.value = t("toolTargetPicker.loadFailed", { message });
    }
  } finally {
    if (!disposed && request === loadGeneration) loading.value = false;
  }
}

function onConnectionChanged(connectionId: string) {
  selectedConnectionId.value = connectionId;
  selectedDatabase.value = "";
  databases.value = [];
  void prepareConnection(connectionId);
}

function onDatabaseChanged(database: string) {
  selectedDatabase.value = database;
}

function initializeDialog() {
  loadGeneration++;
  clearTargetState();
  const connectionId = initialConnectionCandidate();
  selectedConnectionId.value = connectionId;
  // Never carry the active tab's database onto a different fallback connection.
  initialDatabaseConnectionId = connectionId === props.initialConnectionId ? connectionId : "";
  if (connectionId) void prepareConnection(connectionId);
}

function confirmSelection() {
  if (!canConfirm.value) return;
  const connectionId = selectedConnectionId.value;
  // Validate again at the emit boundary so a changed connection list or an
  // asynchronous response can never pair a database with another connection.
  if (!eligibleConnections.value.some((connection) => connection.id === connectionId)) return;
  if (needsDatabase.value && (!selectedDatabase.value || !databases.value.includes(selectedDatabase.value))) return;

  const target: ToolTarget = needsDatabase.value ? { kind: props.kind, connectionId, database: selectedDatabase.value } : { kind: props.kind, connectionId };
  emit("confirm", target);
  emit("update:open", false);
}

watch(
  () => [props.open, props.kind, props.initialConnectionId, props.initialDatabase] as const,
  ([isOpen]) => {
    if (isOpen) initializeDialog();
    else resetForClosedDialog();
  },
  { immediate: true },
);

watch(eligibleConnectionIds, () => {
  if (!props.open) return;
  if (selectedConnectionId.value && eligibleConnections.value.some((connection) => connection.id === selectedConnectionId.value)) return;
  initializeDialog();
});

onBeforeUnmount(() => {
  disposed = true;
  loadGeneration++;
});
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t(titleKey[props.kind]) }}</DialogTitle>
        <DialogDescription>{{ t(descriptionKey[props.kind]) }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <label class="text-sm font-medium">{{ t("editor.selectConnection") }}</label>
          <SearchableSelect
            data-testid="connection-picker"
            :model-value="selectedConnectionId"
            @update:model-value="onConnectionChanged"
            :options="connectionSelectOptions"
            :placeholder="t('editor.selectConnection')"
            :search-placeholder="t('editor.searchConnection')"
            :empty-text="t('common.noResults')"
            :display-name="titleForConnection"
            :disabled="connectionSelectOptions.length === 0"
            trigger-variant="outline"
            trigger-class="w-full"
          />
          <p v-if="connectionSelectOptions.length === 0" role="status" class="text-xs text-muted-foreground">
            {{ t("toolTargetPicker.noConnections") }}
          </p>
        </div>

        <div v-if="needsDatabase" class="space-y-1.5">
          <label class="text-sm font-medium">{{ t("editor.selectDatabase") }}</label>
          <SearchableSelect
            data-testid="database-picker"
            :model-value="selectedDatabase"
            @update:model-value="onDatabaseChanged"
            :options="databaseSelectOptions"
            :placeholder="t('editor.selectDatabase')"
            :search-placeholder="t('editor.searchDatabase')"
            :empty-text="t('common.noResults')"
            :disabled="!selectedConnectionId || loading || databaseSelectOptions.length === 0"
            :loading="loading && needsDatabase"
            :loading-text="t('toolTargetPicker.loadingDatabases')"
            trigger-variant="outline"
            trigger-class="w-full"
          />
        </div>

        <p v-if="loading" role="status" aria-live="polite" class="text-xs text-muted-foreground">
          {{ needsDatabase ? t("toolTargetPicker.loadingDatabases") : t("toolTargetPicker.connecting") }}
        </p>
        <p v-else-if="loadError" role="alert" class="text-xs text-destructive">
          {{ loadError }}
        </p>
        <p v-else-if="needsDatabase && selectedConnectionId && databaseSelectOptions.length === 0" role="status" class="text-xs text-muted-foreground">
          {{ t("toolTargetPicker.noDatabases") }}
        </p>
      </div>

      <DialogFooter class="gap-2 sm:gap-2">
        <Button type="button" variant="outline" @click="emit('update:open', false)">
          {{ t("common.cancel") }}
        </Button>
        <Button type="button" :disabled="!canConfirm" @click="confirmSelection">
          {{ t("common.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
