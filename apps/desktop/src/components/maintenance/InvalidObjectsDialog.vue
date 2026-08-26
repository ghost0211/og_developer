<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Check, CheckCircle2, Code2, Loader2, RefreshCw, RotateCcw, Search } from "@lucide/vue";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import * as api from "@/lib/backend/api";
import type { InvalidObjectInfo, RecompileObjectResult } from "@/lib/backend/api";
import type { ObjectSourceKind } from "@/types/database";

const props = defineProps<{
  open: boolean;
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

const selectedConnectionId = ref(props.prefillConnectionId || "");
const selectedDatabase = ref(props.prefillDatabase || "");
const selectedSchema = ref(props.prefillSchema || "");

const loading = ref(false);
const compiling = ref(false);
const searchQuery = ref("");
const typeFilter = ref<string>("ALL");

interface InvalidItem extends InvalidObjectInfo {
  compileStatus?: "idle" | "compiling" | "success" | "error";
  compileError?: string;
  compileElapsedMs?: number;
}

const items = ref<InvalidItem[]>([]);
const selectedKeys = ref<Set<string>>(new Set());

// Progress state
const progressTotal = ref(0);
const progressCurrent = ref(0);
const progressSuccessCount = ref(0);
const progressErrorCount = ref(0);
let batchRunId = 0;

const connections = computed(() => connectionStore.connections.filter((connection) => connection.db_type === "opengauss" || connection.db_type === "gaussdb"));
const databases = ref<string[]>([]);
const schemas = ref<string[]>([]);

function itemKey(item: InvalidObjectInfo): string {
  return `${item.schema}:${item.name}:${item.objectType}`;
}

const filteredItems = computed(() => {
  return items.value.filter((item) => {
    if (typeFilter.value !== "ALL" && item.objectType !== typeFilter.value) return false;
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return true;
    return item.name.toLowerCase().includes(q) || item.schema.toLowerCase().includes(q) || (item.errorMessage && item.errorMessage.toLowerCase().includes(q));
  });
});

const isAllSelected = computed(() => {
  if (filteredItems.value.length === 0) return false;
  return filteredItems.value.every((item) => selectedKeys.value.has(itemKey(item)));
});

function toggleSelectAll() {
  if (isAllSelected.value) {
    selectedKeys.value.clear();
  } else {
    for (const item of filteredItems.value) {
      selectedKeys.value.add(itemKey(item));
    }
  }
}

function toggleSelectItem(item: InvalidObjectInfo) {
  const k = itemKey(item);
  if (selectedKeys.value.has(k)) {
    selectedKeys.value.delete(k);
  } else {
    selectedKeys.value.add(k);
  }
}

async function loadScopeOptions() {
  const connectionId = selectedConnectionId.value;
  const config = connectionStore.getConfig(connectionId);
  if (!connectionId || !config) {
    databases.value = [];
    schemas.value = [];
    return;
  }

  try {
    await connectionStore.ensureConnected(connectionId);
    const databaseRows = await api.listDatabases(connectionId);
    databases.value = databaseOptionsForConnection(
      databaseRows.map((database) => database.name),
      config,
    );
  } catch (error) {
    console.warn("[InvalidObjects] failed to load database options", error);
    databases.value = config.database ? [config.database] : ["postgres"];
  }

  if (!selectedDatabase.value || !databases.value.includes(selectedDatabase.value)) {
    selectedDatabase.value = databases.value[0] || config.database || "postgres";
  }

  try {
    schemas.value = selectedDatabase.value ? await api.listSchemas(connectionId, selectedDatabase.value) : [];
  } catch (error) {
    console.warn("[InvalidObjects] failed to load schema options", error);
    schemas.value = [];
  }
  if (selectedSchema.value && schemas.value.length > 0 && !schemas.value.includes(selectedSchema.value)) {
    selectedSchema.value = "";
  }
}

async function onConnectionChanged() {
  selectedDatabase.value = "";
  selectedSchema.value = "";
  await loadScopeOptions();
  await scanInvalidObjects();
}

async function onDatabaseChanged() {
  selectedSchema.value = "";
  await loadScopeOptions();
  await scanInvalidObjects();
}

async function onSchemaChanged() {
  await scanInvalidObjects();
}

async function scanInvalidObjects() {
  if (!selectedConnectionId.value || !selectedDatabase.value) return;
  loading.value = true;
  selectedKeys.value.clear();
  try {
    const res = await api.listInvalidObjects(selectedConnectionId.value, selectedDatabase.value, selectedSchema.value || undefined);
    items.value = res.map((item) => ({ ...item, compileStatus: "idle" }));
    if (res.length === 0) {
      toast(t("invalidObjects.scanEmptyToast"), 2000);
    }
  } catch (e: any) {
    toast(t("invalidObjects.scanFailed", { message: e?.message || String(e) }), 3000);
  } finally {
    loading.value = false;
  }
}

async function recompileSingle(item: InvalidItem) {
  if (!selectedConnectionId.value || !selectedDatabase.value) return;
  item.compileStatus = "compiling";
  try {
    const res: RecompileObjectResult = await api.recompileObject(selectedConnectionId.value, selectedDatabase.value, item.schema, item.name, item.objectType);
    item.compileElapsedMs = res.elapsedMs;
    if (res.success) {
      item.compileStatus = "success";
      item.compileError = undefined;
      toast(t("invalidObjects.compileSuccess", { name: `${item.schema}.${item.name}`, elapsed: res.elapsedMs }), 1500);
      await scanInvalidObjects();
    } else {
      item.compileStatus = "error";
      item.compileError = res.error;
      toast(t("invalidObjects.compileError", { message: res.error?.slice(0, 80) || t("invalidObjects.compileFailed") }), 3000);
    }
  } catch (e: any) {
    item.compileStatus = "error";
    item.compileError = e?.message || String(e);
    toast(t("invalidObjects.compileException", { message: item.compileError }), 3000);
  }
}

async function recompileBatch(targets: InvalidItem[]) {
  if (targets.length === 0 || !selectedConnectionId.value || !selectedDatabase.value) return;
  const runId = ++batchRunId;
  compiling.value = true;
  progressTotal.value = targets.length;
  progressCurrent.value = 0;
  progressSuccessCount.value = 0;
  progressErrorCount.value = 0;

  try {
    for (const item of targets) {
      if (runId !== batchRunId || !props.open) return;
      item.compileStatus = "compiling";
      try {
        const res: RecompileObjectResult = await api.recompileObject(selectedConnectionId.value, selectedDatabase.value, item.schema, item.name, item.objectType);
        if (runId !== batchRunId || !props.open) return;
        item.compileElapsedMs = res.elapsedMs;
        if (res.success) {
          item.compileStatus = "success";
          item.compileError = undefined;
          progressSuccessCount.value++;
        } else {
          item.compileStatus = "error";
          item.compileError = res.error;
          progressErrorCount.value++;
        }
      } catch (e: any) {
        if (runId !== batchRunId || !props.open) return;
        item.compileStatus = "error";
        item.compileError = e?.message || String(e);
        progressErrorCount.value++;
      }
      progressCurrent.value++;
    }

    if (runId !== batchRunId || !props.open) return;
    toast(t("invalidObjects.batchComplete", { success: progressSuccessCount.value, failed: progressErrorCount.value }), 3000);
    await scanInvalidObjects();
  } finally {
    if (runId === batchRunId) compiling.value = false;
  }
}

function recompileSelected() {
  const targets = items.value.filter((item) => selectedKeys.value.has(itemKey(item)));
  void recompileBatch(targets);
}

function recompileAll() {
  void recompileBatch(filteredItems.value);
}

function openInProgramWindow(item: InvalidObjectInfo) {
  let kind: ObjectSourceKind = "PROCEDURE";
  const t = item.objectType.toUpperCase();
  if (t === "FUNCTION") kind = "FUNCTION";
  else if (t === "PACKAGE") kind = "PACKAGE";
  else if (t === "PACKAGE BODY" || t === "PACKAGE_BODY") kind = "PACKAGE_BODY";

  queryStore.openProgramWindow({
    connectionId: selectedConnectionId.value,
    database: selectedDatabase.value,
    schema: item.schema,
    name: item.name,
    objectType: kind,
  });
  emit("update:open", false);
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      batchRunId++;
      compiling.value = false;
      return;
    }
    if (isOpen) {
      selectedConnectionId.value = props.prefillConnectionId || selectedConnectionId.value || connectionStore.activeConnectionId || connections.value[0]?.id || "";
      if (props.prefillDatabase) selectedDatabase.value = props.prefillDatabase;
      if (props.prefillSchema) selectedSchema.value = props.prefillSchema;
      void (async () => {
        await loadScopeOptions();
        if (props.prefillDatabase) selectedDatabase.value = props.prefillDatabase;
        if (props.prefillSchema) selectedSchema.value = props.prefillSchema;
        await scanInvalidObjects();
      })();
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-[min(94vw,1120px)] h-[620px] flex flex-col p-0 gap-0 overflow-hidden select-text">
      <!-- Header -->
      <DialogHeader class="px-5 py-3 border-b bg-muted/30 shrink-0">
        <div class="flex items-center justify-between pr-10">
          <div class="flex items-center gap-2">
            <RotateCcw class="h-4 w-4 text-primary" />
            <DialogTitle class="text-sm font-semibold">{{ t("invalidObjects.title") }}</DialogTitle>
          </div>
          <Badge variant="outline" class="text-[11px] font-mono border-destructive/40 text-destructive bg-destructive/10">{{ t("invalidObjects.badge") }}</Badge>
        </div>
      </DialogHeader>

      <!-- Scope Selector Bar -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5 border-b bg-muted/10 text-xs shrink-0 select-none">
        <!-- Connection -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("invalidObjects.connection") }}</span>
          <select v-model="selectedConnectionId" class="h-7 w-36 rounded border bg-background px-2 text-xs outline-none" :disabled="compiling || loading" @change="void onConnectionChanged()">
            <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </div>

        <!-- Database -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("invalidObjects.database") }}</span>
          <select v-model="selectedDatabase" class="h-7 w-28 rounded border bg-background px-2 text-xs outline-none" :disabled="compiling || loading" @change="void onDatabaseChanged()">
            <option v-for="d in databases" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>

        <!-- Schema -->
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-muted-foreground shrink-0">{{ t("invalidObjects.schema") }}</span>
          <select v-model="selectedSchema" class="h-7 w-32 rounded border bg-background px-2 text-xs outline-none" :disabled="compiling || loading" @change="void onSchemaChanged()">
            <option value="">{{ t("invalidObjects.allSchemas") }}</option>
            <option v-for="schemaName in schemas" :key="schemaName" :value="schemaName">{{ schemaName }}</option>
          </select>
        </div>

        <!-- Scan Button -->
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs shrink-0" :disabled="loading || compiling" @click="scanInvalidObjects">
          <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
          <span>{{ t("invalidObjects.scan") }}</span>
        </Button>

        <!-- Filter & Search -->
        <div class="ml-auto flex items-center gap-2 shrink-0">
          <!-- Type Filter -->
          <select v-model="typeFilter" class="h-7 w-32 rounded border bg-background px-2 text-xs outline-none">
            <option value="ALL">{{ t("invalidObjects.allTypes") }}</option>
            <option value="PROCEDURE">{{ t("invalidObjects.procedure") }} (PROCEDURE)</option>
            <option value="FUNCTION">{{ t("invalidObjects.function") }} (FUNCTION)</option>
            <option value="PACKAGE">{{ t("invalidObjects.package") }} (PACKAGE)</option>
            <option value="PACKAGE BODY">{{ t("invalidObjects.packageBody") }} (PACKAGE BODY)</option>
          </select>

          <!-- Search Input -->
          <div class="relative w-40">
            <Search class="absolute left-2 top-1.5 h-3.5 w-3.5 text-muted-foreground/60 pointer-events-none" />
            <input v-model="searchQuery" type="text" :placeholder="t('invalidObjects.filterPlaceholder')" class="h-7 w-full rounded border bg-background pl-7 pr-2 text-xs outline-none focus:border-ring" />
          </div>
        </div>
      </div>

      <!-- Batch Progress Strip (when compiling) -->
      <div v-if="compiling" class="px-5 py-2 border-b bg-amber-500/10 text-xs flex items-center justify-between shrink-0">
        <div class="flex items-center gap-2">
          <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{{ t("invalidObjects.batchProgress", { current: progressCurrent, total: progressTotal }) }}</span>
        </div>
        <div class="flex items-center gap-3 font-mono text-[11px]">
          <span class="text-emerald-600 font-medium">{{ t("invalidObjects.success", { count: progressSuccessCount }) }}</span>
          <span class="text-destructive font-medium">{{ t("invalidObjects.failed", { count: progressErrorCount }) }}</span>
        </div>
      </div>

      <!-- Main Table Container -->
      <div class="flex-1 min-h-0 overflow-auto p-0">
        <div v-if="connections.length === 0" class="flex flex-col h-full items-center justify-center p-8 gap-2 text-muted-foreground text-center">
          <AlertCircle class="h-8 w-8 text-amber-500" />
          <span class="font-medium text-foreground text-xs">{{ t("invalidObjects.noConnections") }}</span>
          <span class="text-[11px]">{{ t("invalidObjects.noConnectionsHint") }}</span>
        </div>

        <div v-else-if="loading" class="flex h-full items-center justify-center p-8 text-xs text-muted-foreground gap-2">
          <Loader2 class="h-4 w-4 animate-spin text-primary" />
          <span>{{ t("invalidObjects.loading") }}</span>
        </div>

        <div v-else-if="items.length === 0" class="flex flex-col h-full items-center justify-center p-8 gap-2 text-muted-foreground text-center">
          <CheckCircle2 class="h-8 w-8 text-emerald-500" />
          <span class="font-medium text-foreground text-xs">{{ t("invalidObjects.empty") }}</span>
          <span class="text-[11px]">{{ t("invalidObjects.emptyHint") }}</span>
        </div>

        <div v-else class="w-full">
          <table class="w-full text-left text-xs border-collapse font-sans">
            <thead class="sticky top-0 bg-muted/90 backdrop-blur z-10 border-b text-muted-foreground font-medium select-none">
              <tr>
                <th class="py-2 px-3 w-[40px] text-center">
                  <input type="checkbox" class="h-3.5 w-3.5 accent-primary cursor-pointer" :checked="isAllSelected" @change="toggleSelectAll" />
                </th>
                <th class="py-2 px-3 w-[100px]">{{ t("invalidObjects.status") }}</th>
                <th class="py-2 px-3 w-[140px]">{{ t("invalidObjects.type") }}</th>
                <th class="py-2 px-3 w-[200px]">{{ t("invalidObjects.objectName") }}</th>
                <th class="py-2 px-3">{{ t("invalidObjects.errorColumn") }}</th>
                <th class="py-2 px-3 w-[140px] text-right">{{ t("invalidObjects.actions") }}</th>
              </tr>
            </thead>
            <tbody class="divide-y font-mono">
              <tr v-for="item in filteredItems" :key="itemKey(item)" class="hover:bg-muted/40 transition-colors" :class="{ 'bg-primary/5': selectedKeys.has(itemKey(item)) }">
                <!-- Checkbox -->
                <td class="py-2 px-3 text-center">
                  <input type="checkbox" class="h-3.5 w-3.5 accent-primary cursor-pointer" :checked="selectedKeys.has(itemKey(item))" @change="toggleSelectItem(item)" />
                </td>

                <!-- Status -->
                <td class="py-2 px-3">
                  <Badge v-if="item.compileStatus === 'compiling'" variant="outline" class="border-amber-500/40 text-amber-600 gap-1 text-[10px]">
                    <Loader2 class="h-2.5 w-2.5 animate-spin" />
                    <span>{{ t("invalidObjects.compiling") }}</span>
                  </Badge>
                  <Badge v-else-if="item.compileStatus === 'success'" variant="outline" class="border-emerald-500/40 text-emerald-600 bg-emerald-500/10 gap-1 text-[10px]">
                    <Check class="h-2.5 w-2.5 text-emerald-500" />
                    <span>{{ t("invalidObjects.fixed") }}</span>
                  </Badge>
                  <Badge v-else variant="destructive" class="gap-1 text-[10px]">
                    <AlertCircle class="h-2.5 w-2.5" />
                    <span>INVALID</span>
                  </Badge>
                </td>

                <!-- Type -->
                <td class="py-2 px-3 font-sans">
                  <Badge variant="secondary" class="text-[10px] font-mono">{{ item.objectType }}</Badge>
                </td>

                <!-- Name -->
                <td class="py-2 px-3 font-bold text-foreground truncate" :title="`${item.schema}.${item.name}`">
                  <span class="text-muted-foreground font-normal text-[11px]">{{ item.schema }}.</span>{{ item.name }}
                </td>

                <!-- Error Message -->
                <td class="py-2 px-3 font-sans text-destructive text-[11px]">
                  <div class="line-clamp-2" :title="item.compileError || item.errorMessage || t('invalidObjects.compileFailed')">
                    <span v-if="item.errorLine" class="font-mono font-bold underline mr-1.5">[Line {{ item.errorLine }}]</span>
                    <span>{{ item.compileError || item.errorMessage || t("invalidObjects.undefinedDependency") }}</span>
                  </div>
                </td>

                <!-- Actions -->
                <td class="py-2 px-3 text-right">
                  <div class="flex items-center justify-end gap-1 font-sans">
                    <Button variant="outline" size="sm" class="h-6 px-2 text-[11px] gap-1" :disabled="compiling || item.compileStatus === 'compiling'" @click="recompileSingle(item)">
                      <RefreshCw class="h-3 w-3" :class="{ 'animate-spin': item.compileStatus === 'compiling' }" />
                      <span>{{ t("invalidObjects.compile") }}</span>
                    </Button>
                    <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground" :title="t('invalidObjects.editSource')" @click="openInProgramWindow(item)">
                      <Code2 class="h-3.5 w-3.5 text-blue-500" />
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Footer Bar -->
      <DialogFooter class="mx-0 mb-0 px-5 py-3 border-t bg-muted/20 flex flex-row items-center justify-between shrink-0">
        <div class="text-xs text-muted-foreground">
          {{ t("invalidObjects.found", { count: items.length }) }}
          <span v-if="selectedKeys.size > 0">{{ t("invalidObjects.selected", { count: selectedKeys.size }) }}</span>
        </div>

        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="emit('update:open', false)">{{ t("invalidObjects.close") }}</Button>
          <Button variant="secondary" size="sm" class="h-7 text-xs gap-1.5" :disabled="selectedKeys.size === 0 || compiling || loading" @click="recompileSelected">
            <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': compiling }" />
            <span>{{ t("invalidObjects.recompileSelected", { count: selectedKeys.size }) }}</span>
          </Button>
          <Button size="sm" class="h-7 text-xs gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium" :disabled="filteredItems.length === 0 || compiling || loading" @click="recompileAll">
            <RotateCcw class="h-3.5 w-3.5" :class="{ 'animate-spin': compiling }" />
            <span>{{ t("invalidObjects.recompileAll", { count: filteredItems.length }) }}</span>
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
