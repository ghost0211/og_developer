<!--
  SPDX-License-Identifier: Apache-2.0
  OG Developer — openGauss dedicated connection dialog.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { ConnectionConfig, DatabaseConnectionInfo, DatabaseType, HttpTunnelConfig, ProxyTunnelConfig, SshTunnelConfig, TransportLayerConfig } from "@/types/database";
import { useConnectionStore } from "@/stores/connectionStore";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { parseGaussdbHosts, serializeGaussdbHosts, type GaussdbHostEntry } from "@/lib/connection/gaussdbHosts";
import { databaseInfoRows, normalizeDatabaseConnectionInfo } from "@/lib/connection/connectionDatabaseInfo";
import { connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connection/connectionAttemptTimeout";
import { OPENGAUSS_JDBC_DRIVER_CLASS, OPENGAUSS_JDBC_DRIVER_PROFILE, gaussdbIdentifierQuoteStyle, opengaussConnectionMode, setGaussdbIdentifierQuoteStyle, setOpengaussConnectionMode, type GaussdbIdentifierQuoteStyle, type OpengaussConnectionMode } from "@/lib/database/jdbcDialect";
import { CircleHelp, FolderOpen, Loader2, Plus, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, Trash2 } from "@lucide/vue";

export type ConfigTab = "connection" | "advanced" | "tls" | "transport" | "ai-recognize";

const DEFAULT_SSH_USER = "root";

export interface ConnectionForm {
  id?: string;
  name: string;
  db_type: DatabaseType;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  url_params?: string;
  driver_profile?: string;
  driver_label?: string;
  jdbc_driver_class?: string;
  jdbc_driver_paths?: string[];
  external_config?: unknown;
  note?: string;
  color?: string;
  is_production?: boolean;
  production_databases?: string[];
  visible_databases?: string[];
  visible_schemas?: Record<string, string[]>;
  show_system_schemas?: boolean;
  init_script?: string;
  connect_timeout_secs?: number;
  query_timeout_secs?: number;
  idle_timeout_secs?: number;
  keepalive_interval_secs?: number;
  ssl?: boolean;
  ca_cert_path?: string;
  client_cert_path?: string;
  client_key_path?: string;
  transport_layers?: TransportLayerConfig[];
  read_only?: boolean;
  database_info?: DatabaseConnectionInfo;
}

const props = defineProps<{
  open: boolean;
  editingConnectionId?: string | null;
  initialGroupId?: string | null;
  initialTab?: ConfigTab;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [connection: ConnectionConfig];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const tunnelProfileStore = useTunnelProfileStore();
const { toast } = useToast();

const activeTab = ref<ConfigTab>("connection");
const isSubmitting = ref(false);
const isTesting = ref(false);
const testResult = ref<{ ok: boolean; message: string; databaseInfo?: DatabaseConnectionInfo } | null>(null);

function defaultConnectionForm(): ConnectionForm {
  return {
    name: "",
    db_type: "opengauss",
    host: "127.0.0.1",
    port: 5432,
    username: "gaussdb",
    password: "",
    database: "postgres",
    url_params: "",
    driver_profile: "opengauss",
    driver_label: "openGauss",
    show_system_schemas: false,
    connect_timeout_secs: 10,
    query_timeout_secs: 30,
    idle_timeout_secs: 60,
    keepalive_interval_secs: 30,
    ssl: false,
    read_only: false,
    is_production: false,
    transport_layers: [],
  };
}

const form = ref<ConnectionForm>(defaultConnectionForm());
const editingGroupId = ref<string | null>(null);
const opengaussDriverCustomOpen = ref(false);

// Multi-host state for GaussDB / openGauss
const multiHostMode = ref(false);
const multiHostEntries = ref<GaussdbHostEntry[]>([{ host: "127.0.0.1", port: 5432 }]);

watch(
  () => [form.value.host, form.value.port] as const,
  ([h, p]) => {
    if (h && h.includes(",")) {
      multiHostMode.value = true;
      multiHostEntries.value = parseGaussdbHosts(h, p);
    }
  },
  { immediate: true },
);

function updateMultiHostFromEntries() {
  const serialized = serializeGaussdbHosts(multiHostEntries.value);
  form.value.host = serialized.host;
  form.value.port = serialized.port;
}

function addMultiHostEntry() {
  multiHostEntries.value.push({ host: "127.0.0.1", port: 5432 });
  updateMultiHostFromEntries();
}

function removeMultiHostEntry(index: number) {
  if (multiHostEntries.value.length > 1) {
    multiHostEntries.value.splice(index, 1);
    updateMultiHostFromEntries();
  }
}

// openGauss connection mode: JDBC vs Native
const opengaussDriverMode = computed<OpengaussConnectionMode>({
  get: () => opengaussConnectionMode(form.value),
  set: (mode) => {
    setOpengaussConnectionMode(form.value, mode);
  },
});

const isOpengaussJdbcConnection = computed(() => opengaussDriverMode.value === "jdbc");

// Identifier quote style
const identifierQuoteStyle = computed<GaussdbIdentifierQuoteStyle>({
  get: () => gaussdbIdentifierQuoteStyle(form.value),
  set: (style) => {
    setGaussdbIdentifierQuoteStyle(form.value, style);
  },
});

// Transport layer management
const transportType = ref<"none" | "ssh" | "http_tunnel" | "proxy">("none");

const sshConfig = ref<SshTunnelConfig>({
  id: uuid(),
  host: "",
  port: 22,
  user: DEFAULT_SSH_USER,
  password: "",
  auth_method: "password",
  connect_timeout_secs: 10,
});

const httpTunnelConfig = ref<HttpTunnelConfig>({
  id: uuid(),
  url: "",
  token: "",
  connect_timeout_secs: 10,
});

const proxyConfig = ref<ProxyTunnelConfig>({
  id: uuid(),
  proxy_type: "socks5",
  host: "",
  port: 1080,
});

function syncTransportLayersFromForm() {
  const layer = form.value.transport_layers?.[0];
  if (!layer) {
    transportType.value = "none";
  } else if (layer.type === "ssh") {
    transportType.value = "ssh";
    sshConfig.value = { ...layer };
  } else if (layer.type === "http_tunnel") {
    transportType.value = "http_tunnel";
    httpTunnelConfig.value = { ...layer };
  } else if (layer.type === "proxy") {
    transportType.value = "proxy";
    proxyConfig.value = { ...layer };
  }
}

function syncTransportLayersToForm() {
  if (transportType.value === "none") {
    form.value.transport_layers = [];
  } else if (transportType.value === "ssh") {
    form.value.transport_layers = [{ type: "ssh", ...sshConfig.value }];
  } else if (transportType.value === "http_tunnel") {
    form.value.transport_layers = [{ type: "http_tunnel", ...httpTunnelConfig.value }];
  } else if (transportType.value === "proxy") {
    form.value.transport_layers = [{ type: "proxy", ...proxyConfig.value }];
  }
}

// Available tunnel profiles
const availableSshProfiles = computed(() => tunnelProfileStore.profiles.filter((p) => p.type === "ssh"));
const availableHttpProfiles = computed(() => tunnelProfileStore.profiles.filter((p) => p.type === "http_tunnel"));

// AI Recognize state
const aiRecognizeInput = ref("");
const aiRecognizeLoading = ref(false);

async function parseAiRecognize() {
  const text = aiRecognizeInput.value.trim();
  if (!text) return;
  aiRecognizeLoading.value = true;
  try {
    const jdbcMatch = text.match(/jdbc:opengauss:\/\/(?:([^:/]+)(?::(\d+))?\/([^?]+))/i) || text.match(/jdbc:postgresql:\/\/(?:([^:/]+)(?::(\d+))?\/([^?]+))/i);
    if (jdbcMatch) {
      if (jdbcMatch[1]) form.value.host = jdbcMatch[1];
      if (jdbcMatch[2]) form.value.port = Number(jdbcMatch[2]);
      if (jdbcMatch[3]) form.value.database = jdbcMatch[3];
      if (text.includes("jdbc:opengauss:")) {
        opengaussDriverMode.value = "jdbc";
      }
    }
    const userMatch = text.match(/(?:user|username)\s*[:=]\s*([^\s,;]+)/i);
    if (userMatch && userMatch[1]) form.value.username = userMatch[1];
    const passMatch = text.match(/(?:password|pwd)\s*[:=]\s*([^\s,;]+)/i);
    if (passMatch && passMatch[1]) form.value.password = passMatch[1];
    const hostMatch = text.match(/(?:host|server|addr|address)\s*[:=]\s*([^\s,;:]+)/i);
    if (hostMatch && hostMatch[1]) form.value.host = hostMatch[1];
    const portMatch = text.match(/(?:port)\s*[:=]\s*(\d+)/i);
    if (portMatch && portMatch[1]) form.value.port = Number(portMatch[1]);
    const dbMatch = text.match(/(?:database|dbname|db)\s*[:=]\s*([^\s,;]+)/i);
    if (dbMatch && dbMatch[1]) form.value.database = dbMatch[1];

    toast(t("connection.aiRecognizeApplied"), 2500);
    activeTab.value = "connection";
  } catch (e: any) {
    toast(t("connection.aiRecognizeFailed", { error: e.message || String(e) }), 4000);
  } finally {
    aiRecognizeLoading.value = false;
  }
}

// File picker helpers
async function pickFilePath(target: "ca" | "client_cert" | "client_key" | "jdbc_jar" | "ssh_key") {
  if (!isTauriRuntime()) return;
  try {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const filters = target === "jdbc_jar" ? [{ name: "JAR Files", extensions: ["jar"] }] : [{ name: "All Files", extensions: ["*"] }];
    const selected = await openDialog({ multiple: false, directory: false, filters });
    if (typeof selected === "string") {
      if (target === "ca") form.value.ca_cert_path = selected;
      else if (target === "client_cert") form.value.client_cert_path = selected;
      else if (target === "client_key") form.value.client_key_path = selected;
      else if (target === "jdbc_jar") form.value.jdbc_driver_paths = [selected];
      else if (target === "ssh_key") sshConfig.value.key_path = selected;
    }
  } catch (e) {
    console.error("File pick error:", e);
  }
}

// Hydrate form when dialog opens or editingConnectionId changes
watch(
  () => [props.open, props.editingConnectionId] as const,
  ([isOpen, configId]) => {
    if (!isOpen) return;
    activeTab.value = props.initialTab || "connection";
    testResult.value = null;
    if (configId) {
      const existing = connectionStore.getConfig(configId);
      if (existing) {
        form.value = JSON.parse(JSON.stringify(existing));
        editingGroupId.value = connectionStore.groupIdForConnection(configId);
        opengaussDriverCustomOpen.value = (existing.jdbc_driver_paths || []).length > 0;
        syncTransportLayersFromForm();
        if (existing.host.includes(",")) {
          multiHostMode.value = true;
          multiHostEntries.value = parseGaussdbHosts(existing.host, existing.port);
        } else {
          multiHostMode.value = false;
          multiHostEntries.value = [{ host: existing.host || "127.0.0.1", port: existing.port || 5432 }];
        }
        return;
      }
    }
    // New connection
    form.value = defaultConnectionForm();
    editingGroupId.value = props.initialGroupId || null;
    opengaussDriverCustomOpen.value = false;
    multiHostMode.value = false;
    multiHostEntries.value = [{ host: "127.0.0.1", port: 5432 }];
    syncTransportLayersFromForm();
  },
  { immediate: true },
);

function buildFinalConnectionConfig(): ConnectionConfig {
  syncTransportLayersToForm();
  if (multiHostMode.value) {
    updateMultiHostFromEntries();
  }
  const id = form.value.id || props.editingConnectionId || uuid();
  const name = form.value.name.trim() || `${form.value.host}:${form.value.port}`;
  return {
    ...form.value,
    id,
    name,
    db_type: "opengauss",
    host: form.value.host.trim() || "127.0.0.1",
    port: Number(form.value.port) || 5432,
    username: form.value.username.trim(),
    password: form.value.password,
    database: form.value.database.trim() || "postgres",
    driver_profile: form.value.driver_profile || (isOpengaussJdbcConnection.value ? OPENGAUSS_JDBC_DRIVER_PROFILE : "opengauss"),
    driver_label: form.value.driver_label || "openGauss",
    jdbc_driver_class: isOpengaussJdbcConnection.value ? form.value.jdbc_driver_class || OPENGAUSS_JDBC_DRIVER_CLASS : undefined,
  };
}

async function handleTestConnection() {
  isTesting.value = true;
  testResult.value = null;
  const config = buildFinalConnectionConfig();
  const startedAt = performance.now();
  try {
    const timeoutMs = connectionAttemptTimeoutMs(config);
    const timeoutMsg = connectionAttemptTimeoutMessage(timeoutMs);
    const res = await Promise.race([api.testConnection(config), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(timeoutMsg)), timeoutMs))]);
    const elapsed = Math.round(performance.now() - startedAt);
    const rawInfo = typeof res === "object" && res !== null && "databaseInfo" in res ? (res as { databaseInfo?: unknown }).databaseInfo : undefined;
    const rawMessage = typeof res === "object" && res !== null && "message" in res ? (res as { message?: string }).message : String(res);
    const info = normalizeDatabaseConnectionInfo(rawInfo, "openGauss", config.database);
    testResult.value = {
      ok: true,
      message: `${rawMessage || t("connection.testSuccess")} (${elapsed}ms)`,
      databaseInfo: info,
    };
    if (info) {
      form.value.database_info = info;
    }
  } catch (e: any) {
    const elapsed = Math.round(performance.now() - startedAt);
    const errText = formatErrorText(e);
    testResult.value = {
      ok: false,
      message: `${errText} (${elapsed}ms)`,
    };
  } finally {
    isTesting.value = false;
  }
}

function formatErrorText(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) return String((error as any).message);
  return String(error);
}

async function handleSave() {
  isSubmitting.value = true;
  try {
    const config = buildFinalConnectionConfig();
    if (props.editingConnectionId) {
      await connectionStore.updateConnection(config);
    } else {
      await connectionStore.addConnection(config, editingGroupId.value);
    }
    emit("saved", config);
    emit("update:open", false);
  } catch (e: any) {
    toast(t("connection.saveFailed", { error: e.message || String(e) }), 5000);
  } finally {
    isSubmitting.value = false;
  }
}

function handleClose() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
      <DialogHeader class="p-4 pb-2 border-b shrink-0 flex flex-row items-center justify-between">
        <div class="flex items-center gap-2">
          <DatabaseIcon db-type="opengauss" class="h-6 w-6 shrink-0" />
          <DialogTitle class="text-base font-semibold">
            {{ editingConnectionId ? t("connection.editTitle") : t("connection.newTitle") }}
          </DialogTitle>
          <Badge variant="outline" class="text-xs font-normal">openGauss</Badge>
        </div>
      </DialogHeader>

      <Tabs v-model="activeTab" class="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div class="px-4 pt-2 border-b bg-muted/20 shrink-0">
          <TabsList class="grid grid-cols-5 h-8">
            <TabsTrigger value="connection" class="text-xs">{{ t("connection.tabs.general") }}</TabsTrigger>
            <TabsTrigger value="advanced" class="text-xs">{{ t("connection.tabs.advanced") }}</TabsTrigger>
            <TabsTrigger value="tls" class="text-xs">SSL / TLS</TabsTrigger>
            <TabsTrigger value="transport" class="text-xs">{{ t("connection.tabs.sshTunnel") }}</TabsTrigger>
            <TabsTrigger value="ai-recognize" class="text-xs flex items-center gap-1">
              <Sparkles class="h-3 w-3 text-amber-500" />
              <span>{{ t("connection.tabs.aiRecognize") }}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <div class="flex-1 overflow-y-auto p-4 min-h-0">
          <!-- Connection Tab -->
          <TabsContent value="connection" class="mt-0 space-y-4">
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.name") }}</Label>
              <Input v-model="form.name" :placeholder="t('connection.namePlaceholder')" class="h-8 text-xs" />
            </div>

            <!-- openGauss Connection Mode -->
            <div class="space-y-1.5 rounded-md border p-3 bg-muted/10">
              <div class="flex items-center justify-between">
                <Label class="text-xs font-medium">{{ t("connection.opengaussConnectionMode") }}</Label>
                <Select v-model="opengaussDriverMode">
                  <SelectTrigger class="h-7 w-36 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jdbc">{{ t("connection.opengaussConnectionModeJdbc") }}</SelectItem>
                    <SelectItem value="native">{{ t("connection.opengaussConnectionModeNative") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p class="text-[11px] text-muted-foreground">
                {{ isOpengaussJdbcConnection ? t("connection.opengaussConnectionModeJdbcHint") : t("connection.opengaussConnectionModeNativeHint") }}
              </p>

              <!-- Custom JDBC Driver Jar -->
              <div v-if="isOpengaussJdbcConnection" class="mt-2 pt-2 border-t space-y-2">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-medium">{{ t("connection.opengaussJdbcDriver") }}</span>
                  <Button type="button" variant="ghost" size="sm" class="h-6 text-xs px-2" @click="opengaussDriverCustomOpen = !opengaussDriverCustomOpen">
                    {{ opengaussDriverCustomOpen ? t("common.cancel") : t("connection.opengaussJdbcCustomize") }}
                  </Button>
                </div>
                <div v-if="!opengaussDriverCustomOpen" class="text-xs text-muted-foreground bg-muted/30 p-2 rounded">
                  {{ t("connection.opengaussJdbcBundledHint") }}
                </div>
                <div v-else class="flex gap-2 items-center">
                  <Input :model-value="form.jdbc_driver_paths?.[0] || ''" @update:model-value="(v: string | number) => (form.jdbc_driver_paths = v ? [String(v)] : [])" placeholder="opengauss-jdbc.jar" class="h-8 text-xs flex-1" />
                  <Button type="button" variant="outline" size="sm" class="h-8 px-2" @click="pickFilePath('jdbc_jar')">
                    <FolderOpen class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>

            <!-- Multi-Host vs Single Host Toggle -->
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <Label class="text-xs font-medium">{{ t("connection.host") }} & {{ t("connection.port") }}</Label>
                <div class="flex items-center gap-2">
                  <span class="text-[11px] text-muted-foreground">{{ t("connection.multiHost") }}</span>
                  <Switch
                    :model-value="multiHostMode"
                    @update:model-value="
                      (v: boolean) => {
                        multiHostMode = v;
                        if (v && multiHostEntries.length === 0) multiHostEntries = [{ host: form.host || '127.0.0.1', port: form.port || 5432 }];
                        updateMultiHostFromEntries();
                      }
                    "
                  />
                </div>
              </div>

              <!-- Single Host Mode -->
              <div v-if="!multiHostMode" class="grid grid-cols-3 gap-3">
                <div class="col-span-2 space-y-1.5">
                  <Input v-model="form.host" placeholder="127.0.0.1" class="h-8 text-xs" />
                </div>
                <div class="space-y-1.5">
                  <Input v-model.number="form.port" type="number" placeholder="5432" class="h-8 text-xs" />
                </div>
              </div>

              <!-- Multi Host Mode -->
              <div v-else class="space-y-2 rounded-md border p-3 bg-muted/10">
                <div v-for="(entry, index) in multiHostEntries" :key="index" class="flex gap-2 items-center">
                  <Input v-model="entry.host" @input="updateMultiHostFromEntries" placeholder="127.0.0.1" class="h-8 text-xs flex-1" />
                  <Input v-model.number="entry.port" @input="updateMultiHostFromEntries" type="number" placeholder="5432" class="h-8 text-xs w-20" />
                  <Button type="button" variant="ghost" size="icon" class="h-8 w-8 text-destructive" :disabled="multiHostEntries.length <= 1" @click="removeMultiHostEntry(index)">
                    <Trash2 class="h-3.5 w-3.5" />
                  </Button>
                </div>
                <Button type="button" variant="outline" size="sm" class="h-7 text-xs gap-1 w-full" @click="addMultiHostEntry">
                  <Plus class="h-3 w-3" />
                  <span>{{ t("connection.addHost") }}</span>
                </Button>
              </div>
            </div>

            <!-- Database Name -->
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.database") }}</Label>
              <Input v-model="form.database" placeholder="postgres" class="h-8 text-xs" />
            </div>

            <!-- Username & Password -->
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.username") }}</Label>
                <Input v-model="form.username" placeholder="gaussdb" class="h-8 text-xs" />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.password") }}</Label>
                <PasswordInput v-model="form.password" :placeholder="t('connection.passwordPlaceholder')" class="h-8 text-xs" />
              </div>
            </div>

            <!-- URL Parameters -->
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.urlParams") }}</Label>
              <Input v-model="form.url_params" placeholder="loggerLevel=off" class="h-8 text-xs font-mono" />
            </div>
          </TabsContent>

          <!-- Advanced Tab -->
          <TabsContent value="advanced" class="mt-0 space-y-4">
            <!-- Timeouts -->
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.connectTimeout") }} (s)</Label>
                <Input v-model.number="form.connect_timeout_secs" type="number" min="1" class="h-8 text-xs" />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.queryTimeout") }} (s)</Label>
                <Input v-model.number="form.query_timeout_secs" type="number" min="0" class="h-8 text-xs" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.idleTimeout") }} (s)</Label>
                <Input v-model.number="form.idle_timeout_secs" type="number" min="0" class="h-8 text-xs" />
              </div>
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.keepaliveInterval") }} (s)</Label>
                <Input v-model.number="form.keepalive_interval_secs" type="number" min="1" class="h-8 text-xs" />
              </div>
            </div>

            <!-- Identifier Quote Style -->
            <div class="space-y-1.5">
              <div class="flex items-center justify-between">
                <Label class="text-xs font-medium">{{ t("connection.identifierQuoteStyle") }}</Label>
                <Select v-model="identifierQuoteStyle">
                  <SelectTrigger class="h-7 w-36 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{{ t("connection.identifierQuoteAuto") }}</SelectItem>
                    <SelectItem value="double">{{ t("connection.identifierQuoteDouble") }} (")</SelectItem>
                    <SelectItem value="backtick">{{ t("connection.identifierQuoteBacktick") }} (`)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <!-- Flags -->
            <div class="space-y-3 pt-2 border-t">
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-xs font-medium">{{ t("connection.showSystemSchemas") }}</div>
                  <div class="text-[11px] text-muted-foreground">{{ t("connection.showSystemSchemasHint") }}</div>
                </div>
                <Switch :model-value="!!form.show_system_schemas" @update:model-value="(v: boolean) => (form.show_system_schemas = v)" />
              </div>

              <div class="flex items-center justify-between">
                <div>
                  <div class="text-xs font-medium">{{ t("connection.readOnly") }}</div>
                  <div class="text-[11px] text-muted-foreground">{{ t("connection.readOnlyHint") }}</div>
                </div>
                <Switch :model-value="!!form.read_only" @update:model-value="(v: boolean) => (form.read_only = v)" />
              </div>

              <!-- Production Environment Safety -->
              <div class="flex items-center justify-between">
                <div>
                  <div class="text-xs font-medium flex items-center gap-1.5">
                    <ShieldAlert class="h-3.5 w-3.5 text-red-500" />
                    <span>{{ t("production.title") }}</span>
                  </div>
                  <div class="text-[11px] text-muted-foreground">{{ t("production.markerHint") }}</div>
                </div>
                <Switch :model-value="!!form.is_production" @update:model-value="(v: boolean) => (form.is_production = v)" />
              </div>
            </div>

            <!-- Init Script -->
            <div class="space-y-1.5 pt-2 border-t">
              <Label class="text-xs font-medium">{{ t("connection.initScript") }}</Label>
              <Input v-model="form.init_script" placeholder="SET timezone TO 'PRC';" class="h-8 text-xs font-mono" />
            </div>

            <!-- Notes -->
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.note") }}</Label>
              <Input v-model="form.note" :placeholder="t('connection.notePlaceholder')" class="h-8 text-xs" />
            </div>
          </TabsContent>

          <!-- TLS / SSL Tab -->
          <TabsContent value="tls" class="mt-0 space-y-4">
            <div class="flex items-center justify-between p-3 rounded-md border bg-muted/10">
              <div>
                <div class="text-xs font-medium flex items-center gap-1.5">
                  <ShieldCheck class="h-4 w-4 text-emerald-600" />
                  <span>{{ t("connection.sslEnable") }}</span>
                </div>
                <div class="text-[11px] text-muted-foreground">{{ t("connection.sslHint") }}</div>
              </div>
              <Switch :model-value="!!form.ssl" @update:model-value="(v: boolean) => (form.ssl = v)" />
            </div>

            <div v-if="form.ssl" class="space-y-3">
              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.sslCaCert") }}</Label>
                <div class="flex gap-2">
                  <Input v-model="form.ca_cert_path" placeholder="/path/to/ca.crt" class="h-8 text-xs flex-1" />
                  <Button type="button" variant="outline" size="sm" class="h-8 px-2" @click="pickFilePath('ca')">
                    <FolderOpen class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.sslClientCert") }}</Label>
                <div class="flex gap-2">
                  <Input v-model="form.client_cert_path" placeholder="/path/to/client.crt" class="h-8 text-xs flex-1" />
                  <Button type="button" variant="outline" size="sm" class="h-8 px-2" @click="pickFilePath('client_cert')">
                    <FolderOpen class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("connection.sslClientKey") }}</Label>
                <div class="flex gap-2">
                  <Input v-model="form.client_key_path" placeholder="/path/to/client.key" class="h-8 text-xs flex-1" />
                  <Button type="button" variant="outline" size="sm" class="h-8 px-2" @click="pickFilePath('client_key')">
                    <FolderOpen class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- Transport Tab (SSH / HTTP Tunnel / Proxy) -->
          <TabsContent value="transport" class="mt-0 space-y-4">
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.transportType") }}</Label>
              <Select v-model="transportType">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{{ t("connection.transportNone") }}</SelectItem>
                  <SelectItem value="ssh">SSH {{ t("connection.tunnel") }}</SelectItem>
                  <SelectItem value="http_tunnel">HTTP {{ t("connection.tunnel") }}</SelectItem>
                  <SelectItem value="proxy">Proxy {{ t("connection.proxy") }} (SOCKS5 / HTTP)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <!-- SSH Tunnel Configuration -->
            <div v-if="transportType === 'ssh'" class="space-y-3 rounded-md border p-3 bg-muted/10">
              <!-- Shared Profile Selector -->
              <div v-if="availableSshProfiles.length > 0" class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("tunnelProfiles.useSharedProfile") }}</Label>
                <Select :model-value="sshConfig.profile_id || ''" @update:model-value="(v: any) => (sshConfig.profile_id = v || undefined)">
                  <SelectTrigger class="h-8 text-xs">
                    <SelectValue :placeholder="t('tunnelProfiles.selectProfile')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{{ t("tunnelProfiles.customConfiguration") }}</SelectItem>
                    <SelectItem v-for="p in availableSshProfiles" :key="p.id" :value="p.id">{{ p.name || p.host }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div v-if="!sshConfig.profile_id" class="space-y-3">
                <div class="grid grid-cols-3 gap-2">
                  <div class="col-span-2 space-y-1">
                    <Label class="text-xs font-medium">SSH {{ t("connection.host") }}</Label>
                    <Input v-model="sshConfig.host" placeholder="ssh.example.com" class="h-8 text-xs" />
                  </div>
                  <div class="space-y-1">
                    <Label class="text-xs font-medium">SSH {{ t("connection.port") }}</Label>
                    <Input v-model.number="sshConfig.port" type="number" placeholder="22" class="h-8 text-xs" />
                  </div>
                </div>

                <div class="grid grid-cols-2 gap-2">
                  <div class="space-y-1">
                    <Label class="text-xs font-medium">SSH {{ t("connection.username") }}</Label>
                    <Input v-model="sshConfig.user" placeholder="root" class="h-8 text-xs" />
                  </div>
                  <div class="space-y-1">
                    <Label class="text-xs font-medium">{{ t("connection.authMethod") }}</Label>
                    <Select v-model="sshConfig.auth_method">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="password">{{ t("connection.authPassword") }}</SelectItem>
                        <SelectItem value="key">{{ t("connection.authKey") }}</SelectItem>
                        <SelectItem value="key+password">{{ t("connection.authKeyAndPassword") }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div v-if="sshConfig.auth_method === 'password' || sshConfig.auth_method === 'key+password'" class="space-y-1">
                  <Label class="text-xs font-medium">SSH {{ t("connection.password") }}</Label>
                  <PasswordInput v-model="sshConfig.password" class="h-8 text-xs" />
                </div>

                <div v-if="sshConfig.auth_method === 'key' || sshConfig.auth_method === 'key+password'" class="space-y-2">
                  <div class="space-y-1">
                    <Label class="text-xs font-medium">{{ t("connection.privateKeyPath") }}</Label>
                    <div class="flex gap-2">
                      <Input v-model="sshConfig.key_path" placeholder="~/.ssh/id_rsa" class="h-8 text-xs flex-1" />
                      <Button type="button" variant="outline" size="sm" class="h-8 px-2" @click="pickFilePath('ssh_key')">
                        <FolderOpen class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <div class="space-y-1">
                    <Label class="text-xs font-medium">{{ t("connection.passphrase") }}</Label>
                    <PasswordInput v-model="sshConfig.key_passphrase" class="h-8 text-xs" />
                  </div>
                </div>
              </div>
            </div>

            <!-- HTTP Tunnel Configuration -->
            <div v-if="transportType === 'http_tunnel'" class="space-y-3 rounded-md border p-3 bg-muted/10">
              <div v-if="availableHttpProfiles.length > 0" class="space-y-1.5">
                <Label class="text-xs font-medium">{{ t("tunnelProfiles.useSharedProfile") }}</Label>
                <Select :model-value="httpTunnelConfig.profile_id || ''" @update:model-value="(v: any) => (httpTunnelConfig.profile_id = v || undefined)">
                  <SelectTrigger class="h-8 text-xs">
                    <SelectValue :placeholder="t('tunnelProfiles.selectProfile')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{{ t("tunnelProfiles.customConfiguration") }}</SelectItem>
                    <SelectItem v-for="p in availableHttpProfiles" :key="p.id" :value="p.id">{{ p.name || (p as HttpTunnelConfig).url }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div v-if="!httpTunnelConfig.profile_id" class="space-y-2">
                <div class="space-y-1">
                  <Label class="text-xs font-medium">{{ t("connection.tunnelUrl") }}</Label>
                  <Input v-model="httpTunnelConfig.url" placeholder="https://example.com/dbx_tunnel.php" class="h-8 text-xs" />
                </div>
                <div class="space-y-1">
                  <Label class="text-xs font-medium">{{ t("connection.tunnelToken") }}</Label>
                  <PasswordInput v-model="httpTunnelConfig.token" class="h-8 text-xs" />
                </div>
              </div>
            </div>

            <!-- Proxy Configuration -->
            <div v-if="transportType === 'proxy'" class="space-y-3 rounded-md border p-3 bg-muted/10">
              <div class="grid grid-cols-4 gap-2">
                <div class="space-y-1">
                  <Label class="text-xs font-medium">{{ t("connection.proxyType") }}</Label>
                  <Select v-model="proxyConfig.proxy_type">
                    <SelectTrigger class="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="socks5">SOCKS5</SelectItem>
                      <SelectItem value="http">HTTP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="col-span-2 space-y-1">
                  <Label class="text-xs font-medium">{{ t("connection.host") }}</Label>
                  <Input v-model="proxyConfig.host" placeholder="127.0.0.1" class="h-8 text-xs" />
                </div>
                <div class="space-y-1">
                  <Label class="text-xs font-medium">{{ t("connection.port") }}</Label>
                  <Input v-model.number="proxyConfig.port" type="number" placeholder="1080" class="h-8 text-xs" />
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- AI Recognize Tab -->
          <TabsContent value="ai-recognize" class="mt-0 space-y-3">
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.aiRecognizeTitle") }}</Label>
              <textarea v-model="aiRecognizeInput" :placeholder="t('connection.aiRecognizePlaceholder')" class="w-full h-36 p-2 text-xs font-mono rounded-md border bg-background resize-none focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <Button type="button" size="sm" class="h-8 text-xs gap-1.5" :disabled="!aiRecognizeInput.trim() || aiRecognizeLoading" @click="parseAiRecognize">
              <Loader2 v-if="aiRecognizeLoading" class="h-3.5 w-3.5 animate-spin" />
              <Sparkles v-else class="h-3.5 w-3.5 text-amber-500" />
              <span>{{ t("connection.aiRecognizeAction") }}</span>
            </Button>
          </TabsContent>
        </div>
      </Tabs>

      <!-- Footer: Test Connection, Save, Cancel -->
      <DialogFooter class="p-3 border-t bg-muted/10 shrink-0 flex items-center justify-between sm:justify-between">
        <div class="flex items-center gap-2 min-w-0">
          <Button type="button" variant="outline" size="sm" class="h-8 text-xs gap-1.5" :disabled="isTesting" @click="handleTestConnection">
            <Loader2 v-if="isTesting" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            <span>{{ t("connection.testConnection") }}</span>
          </Button>

          <!-- Test Result Badge & Info -->
          <div v-if="testResult" class="flex items-center gap-1.5 text-xs truncate max-w-xs" :class="testResult.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'">
            <span class="truncate">{{ testResult.message }}</span>
            <Popover v-if="testResult.ok && testResult.databaseInfo">
              <PopoverTrigger as-child>
                <Button variant="ghost" size="icon" class="h-6 w-6">
                  <CircleHelp class="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-80 p-3 text-xs space-y-2">
                <div class="font-semibold border-b pb-1">{{ t("connection.databaseInfo") }}</div>
                <div v-for="row in databaseInfoRows(testResult.databaseInfo)" :key="row.key" class="flex justify-between py-0.5">
                  <span class="text-muted-foreground">{{ row.key }}:</span>
                  <span class="font-mono">{{ row.value }}</span>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" class="h-8 text-xs" @click="handleClose">
            {{ t("common.cancel") }}
          </Button>
          <Button type="button" size="sm" class="h-8 text-xs" :disabled="isSubmitting" @click="handleSave">
            <Loader2 v-if="isSubmitting" class="h-3.5 w-3.5 animate-spin" />
            <span>{{ t("common.save") }}</span>
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
