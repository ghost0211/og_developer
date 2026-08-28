<!--
  SPDX-License-Identifier: Apache-2.0
  OG Developer — openGauss dedicated connection dialog.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
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
import type { ConnectionConfig, DatabaseConnectionInfo, DatabaseType, HttpTunnelConfig, JdbcDriverInfo, ProxyTunnelConfig, SshTunnelConfig, TransportLayerConfig } from "@/types/database";
import { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } from "@/stores/connectionStore";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { useToast } from "@/composables/useToast";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { ConnectionDeepLinkDraft } from "@/lib/connection/connectionDeepLink";
import { appendConnectionErrorHints } from "@/lib/connection/connectionErrorHints";
import { applyParsedConnectionUrl, parseConnectionUrl } from "@/lib/connection/connectionUrl";
import { connectionUrlPlaceholder } from "@/lib/connection/connectionPresentation";
import { parseGaussdbHosts, serializeGaussdbHosts, type GaussdbHostEntry } from "@/lib/connection/gaussdbHosts";
import { databaseInfoRows, normalizeDatabaseConnectionInfo } from "@/lib/connection/connectionDatabaseInfo";
import { connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connection/connectionAttemptTimeout";
import {
  OPENGAUSS_JDBC_DRIVER_CLASS,
  OPENGAUSS_JDBC_DRIVER_COORDINATE,
  OPENGAUSS_JDBC_DRIVER_PROFILE,
  gaussdbIdentifierQuoteStyle,
  opengaussConnectionMode,
  setGaussdbIdentifierQuoteStyle,
  setOpengaussConnectionMode,
  type GaussdbIdentifierQuoteStyle,
  type OpengaussConnectionMode,
} from "@/lib/database/jdbcDialect";
import { canSaveVisibleDatabaseSelection, filterDatabaseNamesForVisiblePicker, normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";
import { CheckSquare, CircleHelp, FolderOpen, ListFilter, Loader2, Pipette, Plus, RefreshCw, Search, ShieldAlert, ShieldCheck, Sparkles, Square, Trash2 } from "@lucide/vue";

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
  one_time?: boolean;
  database_info?: DatabaseConnectionInfo;
}

const props = defineProps<{
  open: boolean;
  editConfig?: ConnectionConfig;
  prefillConfig?: ConnectionDeepLinkDraft | null;
  initialTab?: ConfigTab;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [connection: ConnectionConfig];
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
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
const editingId = computed(() => props.editConfig?.id || null);
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

// File picker helpers & installed driver management
const installedJdbcDrivers = ref<JdbcDriverInfo[]>([]);
const isImportingDriver = ref(false);

async function loadInstalledJdbcDrivers() {
  try {
    installedJdbcDrivers.value = await api.listJdbcDrivers();
  } catch {
    installedJdbcDrivers.value = [];
  }
}

function chooseWebFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function pickFilePath(target: "ca" | "client_cert" | "client_key" | "jdbc_jar" | "ssh_key") {
  if (isTauriRuntime()) {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const filters = target === "jdbc_jar" ? [{ name: "JAR Files", extensions: ["jar"] }] : [{ name: "All Files", extensions: ["*"] }];
      const selected = await openDialog({ multiple: false, directory: false, filters });
      if (typeof selected === "string") {
        if (target === "ca") form.value.ca_cert_path = selected;
        else if (target === "client_cert") form.value.client_cert_path = selected;
        else if (target === "client_key") form.value.client_key_path = selected;
        else if (target === "jdbc_jar") {
          form.value.jdbc_driver_paths = [selected];
          await loadInstalledJdbcDrivers();
        } else if (target === "ssh_key") sshConfig.value.key_path = selected;
      }
    } catch (e) {
      console.error("File pick error:", e);
    }
  } else {
    if (target === "jdbc_jar") {
      const file = await chooseWebFile(".jar");
      if (!file) return;
      isImportingDriver.value = true;
      try {
        const imported = await api.importJdbcDrivers([file]);
        await loadInstalledJdbcDrivers();
        if (imported && imported.length > 0) {
          form.value.jdbc_driver_paths = [imported[0].path];
          toast(t("settings.jdbcImportSuccess", { count: imported.length }), 2000);
        }
      } catch (e: any) {
        toast(e?.message || String(e), 4000);
      } finally {
        isImportingDriver.value = false;
      }
    }
  }
}

watch(
  () => [props.open, opengaussDriverMode.value] as const,
  ([isOpen, mode]) => {
    if (isOpen && mode === "jdbc") {
      void loadInstalledJdbcDrivers();
    }
  },
  { immediate: true },
);

// Color picker state
const colorOptions = [
  { value: "", class: "bg-transparent border-dashed", labelKey: "connection.colorNone" },
  { value: "#22c55e", class: "bg-green-500", labelKey: "connection.colorGreen" },
  { value: "#eab308", class: "bg-yellow-500", labelKey: "connection.colorYellow" },
  { value: "#f97316", class: "bg-orange-500", labelKey: "connection.colorOrange" },
  { value: "#ef4444", class: "bg-red-500", labelKey: "connection.colorRed" },
  { value: "#3b82f6", class: "bg-blue-500", labelKey: "connection.colorBlue" },
  { value: "#a855f7", class: "bg-purple-500", labelKey: "connection.colorPurple" },
];

const isPresetColor = (color: string | undefined) => colorOptions.some((c) => c.value === (color || ""));
const customColorInput = ref("");
const customColorOpen = ref(false);

function applyCustomColor(value: string) {
  form.value.color = value;
  customColorInput.value = value;
}

function handlePresetClick(color: string) {
  form.value.color = color;
  customColorInput.value = "";
}

function handleCustomColorPicked(value: string) {
  applyCustomColor(value);
}

function handleCustomColorInput(value: string) {
  applyCustomColor(value);
}

// Connection URL parse
const connectionUrlInput = ref("");

function applyConnectionUrl() {
  const input = connectionUrlInput.value.trim();
  if (!input) return;
  try {
    const parsed = parseConnectionUrl(input);
    const updated = applyParsedConnectionUrl(form.value, parsed);
    form.value = {
      ...form.value,
      ...updated,
    };
    if (parsed.host?.includes(",")) {
      multiHostMode.value = true;
      multiHostEntries.value = parseGaussdbHosts(parsed.host, parsed.port);
    } else if (parsed.host) {
      multiHostMode.value = false;
      multiHostEntries.value = [{ host: parsed.host, port: parsed.port || 5432 }];
    }
    if (!form.value.name.trim()) {
      form.value.name = parsed.database || parsed.host || parsed.driverLabel;
    }
    toast(t("connection.parseConnectionUrlApplied"), 2000);
  } catch (e: any) {
    toast(t("connection.parseConnectionUrlFailed", { message: e?.message || String(e) }), 5000);
  }
}

// Helper to load database names via one-time connection
async function fetchDatabaseList(): Promise<string[]> {
  const config = buildFinalConnectionConfig();
  await ensureRequiredOpengaussJdbcRuntime(config);
  const draftId = `__draft_db_list_${uuid()}`;
  const draftConfig = { ...config, id: draftId, one_time: true };
  try {
    await api.connectDb(draftConfig);
    const dbs = await api.listDatabases(draftId);
    return dbs.map((d: any) => d.name);
  } finally {
    await api.disconnectDb(draftId).catch(() => undefined);
  }
}

// Visible Databases state
const showVisibleDatabasesDialog = ref(false);
const isLoadingVisibleDatabases = ref(false);
const visibleDatabaseNames = ref<string[]>([]);
const visibleDatabaseSelection = ref<Set<string>>(new Set());
const visibleDatabaseSearchText = ref("");
const visibleDatabaseError = ref("");
const visibleDatabaseShowSystem = ref(false);

const hasVisibleDatabaseFilter = computed(() => Array.isArray(form.value.visible_databases));
const visibleDatabaseSummary = computed(() => {
  const configured = form.value.visible_databases;
  if (!Array.isArray(configured)) return t("visibleDatabases.showAll");
  return t("visibleDatabases.selectedCount", { selected: configured.length, total: visibleDatabaseNames.value.length || configured.length });
});

const defaultListedVisibleDatabaseNames = computed(() => {
  return filterDatabaseNamesForVisiblePicker(visibleDatabaseNames.value, form.value);
});

const listedVisibleDatabaseNames = computed(() => (visibleDatabaseShowSystem.value ? visibleDatabaseNames.value : defaultListedVisibleDatabaseNames.value));

const filteredVisibleDatabaseNames = computed(() => {
  const query = visibleDatabaseSearchText.value.trim().toLowerCase();
  if (!query) return listedVisibleDatabaseNames.value;
  return listedVisibleDatabaseNames.value.filter((name) => name.toLowerCase().includes(query));
});

const visibleDatabaseSelectedCount = computed(() => visibleDatabaseSelection.value.size);
const visibleDatabaseTotalCount = computed(() => listedVisibleDatabaseNames.value.length);
const visibleDatabaseCanSave = computed(() => canSaveVisibleDatabaseSelection([...visibleDatabaseSelection.value]));
const visibleDatabaseHasSystemObjects = computed(() => defaultListedVisibleDatabaseNames.value.length < visibleDatabaseNames.value.length);

async function openVisibleDatabasesPicker() {
  if (isLoadingVisibleDatabases.value) return;
  isLoadingVisibleDatabases.value = true;
  visibleDatabaseError.value = "";
  visibleDatabaseSearchText.value = "";
  try {
    const names = await fetchDatabaseList();
    visibleDatabaseNames.value = names;
    visibleDatabaseShowSystem.value = false;
    const configured = form.value.visible_databases;
    const initialSelection = Array.isArray(configured) ? normalizeVisibleDatabaseSelection(configured, names) : filterDatabaseNamesForVisiblePicker(names, form.value);
    visibleDatabaseSelection.value = new Set(initialSelection);
    const defaultVisible = new Set(defaultListedVisibleDatabaseNames.value);
    visibleDatabaseShowSystem.value = initialSelection.some((name) => !defaultVisible.has(name));
    showVisibleDatabasesDialog.value = true;
  } catch (e: any) {
    visibleDatabaseNames.value = [];
    visibleDatabaseSelection.value = new Set();
    visibleDatabaseError.value = e?.message || String(e);
    showVisibleDatabasesDialog.value = true;
  } finally {
    isLoadingVisibleDatabases.value = false;
  }
}

function toggleVisibleDatabase(database: string) {
  const next = new Set(visibleDatabaseSelection.value);
  if (next.has(database)) next.delete(database);
  else next.add(database);
  visibleDatabaseSelection.value = next;
}

function selectAllVisibleDatabases() {
  visibleDatabaseSelection.value = new Set(listedVisibleDatabaseNames.value);
}

function clearVisibleDatabaseSelection() {
  visibleDatabaseSelection.value = new Set();
}

function showAllVisibleDatabases() {
  form.value.visible_databases = undefined;
  visibleDatabaseSelection.value = new Set();
  showVisibleDatabasesDialog.value = false;
}

function saveVisibleDatabaseSelection() {
  if (!visibleDatabaseCanSave.value) return;
  form.value.visible_databases = normalizeVisibleDatabaseSelection([...visibleDatabaseSelection.value], visibleDatabaseNames.value);
  showVisibleDatabasesDialog.value = false;
}

// Production Databases state
const showProductionDatabasesDialog = ref(false);
const isLoadingProductionDatabases = ref(false);
const productionDatabaseNames = ref<string[]>([]);
const productionDatabaseSelection = ref<Set<string>>(new Set());
const productionDatabaseSearchText = ref("");
const productionDatabaseError = ref("");

const productionProtectionEnabled = computed({
  get: () => !!form.value.is_production || (form.value.production_databases?.length ?? 0) > 0,
  set: (enabled: boolean) => {
    if (!enabled) {
      form.value.is_production = false;
      form.value.production_databases = [];
    } else if (!form.value.is_production && !form.value.production_databases?.length) {
      form.value.is_production = true;
    }
  },
});

const productionScope = computed<"connection" | "databases">({
  get: () => (form.value.is_production ? "connection" : "databases"),
  set: (scope) => {
    if (scope === "connection") {
      form.value.is_production = true;
      form.value.production_databases = [];
    } else {
      form.value.is_production = false;
    }
  },
});

const filteredProductionDatabaseNames = computed(() => {
  const query = productionDatabaseSearchText.value.trim().toLowerCase();
  if (!query) return productionDatabaseNames.value;
  return productionDatabaseNames.value.filter((name) => name.toLowerCase().includes(query));
});

const productionDatabaseSelectedCount = computed(() => productionDatabaseSelection.value.size);
const productionDatabaseCanSave = computed(() => productionDatabaseNames.value.length > 0 && productionDatabaseSelection.value.size > 0);

const productionDatabaseSummary = computed(() => {
  const selected = form.value.production_databases?.length || 0;
  if (!selected) return t("production.noDatabasesSelected");
  if (!productionDatabaseNames.value.length) return t("production.databasesConfiguredCount", { count: selected });
  return t("production.databasesSelectedCount", { selected, total: productionDatabaseNames.value.length });
});

function initialProductionDatabaseSelection(databaseNames: string[]): string[] {
  const configured = form.value.production_databases || [];
  return configured.length ? normalizeProductionDatabaseSelection(configured, databaseNames) : databaseNames;
}

function normalizeProductionDatabaseSelection(selectedNames: Iterable<string>, databaseNames: string[]): string[] {
  const available = new Map(databaseNames.map((name) => [name.toLowerCase(), name]));
  const selected = new Set<string>();
  for (const name of selectedNames) {
    const canonicalName = available.get(name.toLowerCase());
    if (canonicalName) selected.add(canonicalName);
  }
  return [...selected];
}

async function openProductionDatabasesPicker() {
  if (isLoadingProductionDatabases.value) return;
  isLoadingProductionDatabases.value = true;
  productionDatabaseError.value = "";
  productionDatabaseSearchText.value = "";
  try {
    const names = visibleDatabaseNames.value.length ? visibleDatabaseNames.value : await fetchDatabaseList();
    productionDatabaseNames.value = names;
    visibleDatabaseNames.value = names;
    productionDatabaseSelection.value = new Set(initialProductionDatabaseSelection(names));
    showProductionDatabasesDialog.value = true;
  } catch (e: any) {
    productionDatabaseNames.value = [];
    productionDatabaseSelection.value = new Set();
    productionDatabaseError.value = e?.message || String(e);
    showProductionDatabasesDialog.value = true;
  } finally {
    isLoadingProductionDatabases.value = false;
  }
}

function toggleProductionDatabase(database: string) {
  const next = new Set(productionDatabaseSelection.value);
  if (next.has(database)) next.delete(database);
  else next.add(database);
  productionDatabaseSelection.value = next;
}

function selectAllProductionDatabases() {
  productionDatabaseSelection.value = new Set(productionDatabaseNames.value);
}

function clearProductionDatabaseSelection() {
  productionDatabaseSelection.value = new Set();
}

function saveProductionDatabaseSelection() {
  if (!productionDatabaseCanSave.value) return;
  productionProtectionEnabled.value = true;
  form.value.is_production = false;
  form.value.production_databases = normalizeProductionDatabaseSelection(productionDatabaseSelection.value, productionDatabaseNames.value);
  showProductionDatabasesDialog.value = false;
}

function applyConnectionPrefill(draft: ConnectionDeepLinkDraft) {
  if (draft.host) form.value.host = draft.host;
  if (draft.port) form.value.port = draft.port;
  if (draft.username) form.value.username = draft.username;
  if (draft.password) form.value.password = draft.password;
  if (draft.database) form.value.database = draft.database;
  if (draft.urlParams) form.value.url_params = draft.urlParams;
  if (draft.ssl !== undefined) form.value.ssl = draft.ssl;
  if (draft.name?.trim()) form.value.name = draft.name.trim();
  if (draft.oneTime) form.value.one_time = true;
  setOpengaussConnectionMode(form.value, draft.driverProfile === OPENGAUSS_JDBC_DRIVER_PROFILE ? "jdbc" : "native");
  if (draft.oneTime) {
    void nextTick(() => {
      void handleSave();
    });
  }
}

// JDBC mode needs the plugin runtime plus the official driver jar; both are
// auto-provisioned from Maven when missing so "save" never strands a config
// that cannot connect.
async function ensureRequiredOpengaussJdbcRuntime(config: ConnectionConfig): Promise<void> {
  if (opengaussConnectionMode(config) !== "jdbc") return;
  const status = await api.jdbcPluginStatus();
  if (!(status.installed && status.compatible)) {
    testResult.value = { ok: true, message: t("connection.opengaussJdbcPluginInstalling") };
    await api.installJdbcPlugin();
  }
  if ((config.jdbc_driver_paths ?? []).length) return;
  testResult.value = { ok: true, message: t("connection.opengaussJdbcDriverInstalling") };
  const installed = await api.installJdbcDriverFromMaven(OPENGAUSS_JDBC_DRIVER_COORDINATE);
  const paths = installed.map((driver) => driver.path).filter(Boolean);
  if (paths.length) {
    config.jdbc_driver_paths = paths;
    form.value.jdbc_driver_paths = [...paths];
  }
}

// Hydrate form when dialog opens or the edit target changes
watch(
  () => [props.open, props.editConfig] as const,
  ([isOpen, editConfig]) => {
    if (!isOpen) return;
    activeTab.value = props.initialTab || "connection";
    testResult.value = null;
    if (editConfig) {
      form.value = JSON.parse(JSON.stringify(editConfig));
      opengaussDriverCustomOpen.value = (editConfig.jdbc_driver_paths || []).length > 0;
      syncTransportLayersFromForm();
      if (editConfig.host?.includes(",")) {
        multiHostMode.value = true;
        multiHostEntries.value = parseGaussdbHosts(editConfig.host, editConfig.port);
      } else {
        multiHostMode.value = false;
        multiHostEntries.value = [{ host: editConfig.host || "127.0.0.1", port: editConfig.port || 5432 }];
      }
      return;
    }
    // New connection
    form.value = defaultConnectionForm();
    opengaussDriverCustomOpen.value = false;
    multiHostMode.value = false;
    multiHostEntries.value = [{ host: "127.0.0.1", port: 5432 }];
    syncTransportLayersFromForm();
    if (props.prefillConfig) applyConnectionPrefill(props.prefillConfig);
  },
  { immediate: true },
);

watch(
  () => props.prefillConfig,
  (draft) => {
    if (props.open && draft && !props.editConfig) applyConnectionPrefill(draft);
  },
);

function buildFinalConnectionConfig(): ConnectionConfig {
  syncTransportLayersToForm();
  if (multiHostMode.value) {
    updateMultiHostFromEntries();
  }
  const id = editingId.value || form.value.id || uuid();
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
  if (isSubmitting.value) return;
  isSubmitting.value = true;
  try {
    const config = buildFinalConnectionConfig();
    await ensureRequiredOpengaussJdbcRuntime(config);
    if (editingId.value) {
      await connectionStore.updateConnection(config);
      connectionStore.stopEditing();
      emit("saved", config);
      emit("update:open", false);
      return;
    }
    await connectionStore.addConnection(config);
    emit("saved", config);
    emit("update:open", false);
    await nextTick();
    // New connections follow the legacy "save and connect" flow.
    emit("connectStarted", config.name);
    void connectionStore
      .connect(config)
      .then(() => {
        emit("connectSucceeded", config.name);
      })
      .catch((e: any) => {
        const message = String(e?.message || e);
        if (message.includes(CONNECTION_ATTEMPT_CANCELLED_MESSAGE)) return;
        if (config.one_time) void connectionStore.removeConnection(config.id);
        emit("connectFailed", appendConnectionErrorHints(config, message, t));
      });
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e.message || String(e) }), 5000);
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
            {{ editingId ? t("connection.editTitle") : t("connection.newTitle") }}
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
              <div class="flex items-center justify-between">
                <Label class="text-xs font-medium">{{ t("connection.name") }}</Label>
                <div class="flex items-center gap-1.5">
                  <button
                    v-for="color in colorOptions"
                    :key="color.value || 'none'"
                    type="button"
                    class="h-5 w-5 rounded-full border ring-offset-background transition hover:scale-105"
                    :class="[color.class, (form.color || '') === color.value ? 'ring-2 ring-ring ring-offset-2' : 'border-border']"
                    :title="t(color.labelKey)"
                    @click="handlePresetClick(color.value)"
                  />
                  <Popover v-model:open="customColorOpen">
                    <PopoverTrigger as-child>
                      <button
                        type="button"
                        class="h-5 w-5 rounded-full border flex items-center justify-center hover:scale-105 transition"
                        :class="[!isPresetColor(form.color) && form.color ? 'border-border ring-2 ring-ring ring-offset-2' : 'border-dashed border-border']"
                        :style="!isPresetColor(form.color) && form.color ? { backgroundColor: form.color } : {}"
                        :title="t('connection.colorCustom')"
                      >
                        <Pipette class="h-3 w-3" :class="!isPresetColor(form.color) && form.color ? 'text-white' : 'text-muted-foreground'" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent class="w-auto p-2" align="end">
                      <div class="flex items-center gap-2">
                        <input type="color" :value="form.color || '#3b82f6'" @input="handleCustomColorPicked(($event.target as HTMLInputElement).value)" class="h-6 w-6 cursor-pointer rounded border-0 p-0" />
                        <Input type="text" :value="customColorInput || form.color || ''" @input="handleCustomColorInput(($event.target as HTMLInputElement).value)" class="w-32 h-7 text-xs font-mono" :placeholder="t('connection.customColorPlaceholder')" />
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
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
                <div v-else class="space-y-2">
                  <div v-if="installedJdbcDrivers.length > 0" class="space-y-1">
                    <Select :model-value="form.jdbc_driver_paths?.[0] || ''" @update:model-value="(v: any) => (form.jdbc_driver_paths = v ? [String(v)] : [])">
                      <SelectTrigger class="h-8 text-xs">
                        <SelectValue :placeholder="t('connection.opengaussJdbcDriverPlaceholder')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="d in installedJdbcDrivers" :key="d.path" :value="d.path">
                          {{ d.name }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="flex gap-2 items-center">
                    <Input :model-value="form.jdbc_driver_paths?.[0] || ''" @update:model-value="(v: string | number) => (form.jdbc_driver_paths = v ? [String(v)] : [])" :placeholder="t('connection.opengaussJdbcDriverPlaceholder')" class="h-8 text-xs flex-1 font-mono" />
                    <Button type="button" variant="outline" size="sm" class="h-8 px-2" :disabled="isImportingDriver" @click="pickFilePath('jdbc_jar')">
                      <Loader2 v-if="isImportingDriver" class="h-3.5 w-3.5 animate-spin" />
                      <FolderOpen v-else class="h-3.5 w-3.5" />
                    </Button>
                  </div>
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

            <!-- URL (Optional) Paste / Parse -->
            <div class="space-y-1.5">
              <Label class="text-xs font-medium">{{ t("connection.connectionUrlOptional") }}</Label>
              <div class="flex gap-2">
                <Input v-model="connectionUrlInput" class="h-8 text-xs font-mono flex-1" :placeholder="connectionUrlPlaceholder(form.db_type)" @keydown.enter.prevent="applyConnectionUrl" />
                <Button type="button" variant="outline" size="sm" class="h-8 px-2.5 text-xs shrink-0" :disabled="!connectionUrlInput.trim()" @click="applyConnectionUrl">
                  {{ t("connection.parseConnectionUrl") }}
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
              <div class="rounded-md border border-red-500/25 bg-red-500/[0.035] p-3 space-y-3">
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-1.5">
                    <ShieldAlert class="h-3.5 w-3.5 text-red-500" />
                    <span class="text-xs font-medium">{{ t("production.title") }}</span>
                  </div>
                  <Switch :model-value="productionProtectionEnabled" @update:model-value="productionProtectionEnabled = $event" />
                </div>
                <p v-if="!productionProtectionEnabled" class="text-[11px] text-muted-foreground">{{ t("production.disabledDescription") }}</p>
                <template v-else>
                  <div class="space-y-1.5">
                    <Label class="text-xs font-medium">{{ t("production.scope") }}</Label>
                    <Tabs v-model="productionScope" class="w-full">
                      <TabsList class="grid h-7 w-full grid-cols-2">
                        <TabsTrigger value="connection" class="text-xs">{{ t("production.allDatabases") }}</TabsTrigger>
                        <TabsTrigger value="databases" class="text-xs">{{ t("production.selectedDatabases") }}</TabsTrigger>
                      </TabsList>
                    </Tabs>
                    <p class="text-[11px] text-muted-foreground">
                      {{ productionScope === "connection" ? t("production.connectionDescription") : t("production.databaseDescription") }}
                    </p>
                  </div>
                  <div v-if="productionScope === 'databases'" class="flex items-center justify-between pt-1">
                    <div class="text-xs text-muted-foreground">{{ productionDatabaseSummary }}</div>
                    <Button type="button" variant="outline" size="sm" class="h-7 text-xs gap-1.5" :disabled="isLoadingProductionDatabases" @click="openProductionDatabasesPicker">
                      <Loader2 v-if="isLoadingProductionDatabases" class="h-3 w-3 animate-spin" />
                      <ListFilter v-else class="h-3 w-3" />
                      <span>{{ t("production.selectDatabases") }}</span>
                    </Button>
                  </div>
                </template>
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
      <DialogFooter class="mx-0 mb-0 px-4 py-3.5 border-t bg-muted/10 shrink-0 flex items-center justify-between sm:justify-between">
        <div class="flex items-center gap-2 min-w-0">
          <Button type="button" variant="outline" size="sm" class="h-8 text-xs gap-1.5" :disabled="isTesting" @click="handleTestConnection">
            <Loader2 v-if="isTesting" class="h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="h-3.5 w-3.5" />
            <span>{{ t("connection.testConnection") }}</span>
          </Button>

          <Button type="button" variant="outline" size="sm" class="h-8 text-xs gap-1.5" :disabled="isTesting || isLoadingVisibleDatabases" @click="openVisibleDatabasesPicker">
            <Loader2 v-if="isLoadingVisibleDatabases" class="h-3.5 w-3.5 animate-spin" />
            <ListFilter v-else class="h-3.5 w-3.5" />
            <span>{{ hasVisibleDatabaseFilter ? visibleDatabaseSummary : t("contextMenu.selectVisibleDatabases") }}</span>
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
            <span>{{ isSubmitting ? t("common.loading") : editingId ? t("connection.save") : t("connection.saveAndConnect") }}</span>
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Visible Databases Dialog -->
  <Dialog :open="showVisibleDatabasesDialog" @update:open="showVisibleDatabasesDialog = $event">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ t("visibleDatabases.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">
          {{ t("visibleDatabases.description", { connection: form.name || form.host || "openGauss" }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="visibleDatabaseSearchText" :placeholder="t('visibleDatabases.searchPlaceholder')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0 text-xs" :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {{
            t("visibleDatabases.selectedCount", {
              selected: visibleDatabaseSelectedCount,
              total: visibleDatabaseTotalCount,
            })
          }}
        </span>
        <div class="flex items-center gap-2">
          <button type="button" class="hover:text-foreground disabled:opacity-50 text-xs" :disabled="isLoadingVisibleDatabases" @click="selectAllVisibleDatabases">
            {{ t("visibleDatabases.selectAll") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50 text-xs" :disabled="isLoadingVisibleDatabases" @click="clearVisibleDatabaseSelection">
            {{ t("visibleDatabases.clear") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50 text-xs" :disabled="isLoadingVisibleDatabases" @click="showAllVisibleDatabases">
            {{ t("visibleDatabases.showAll") }}
          </button>
        </div>
      </div>

      <p v-if="!isLoadingVisibleDatabases && !visibleDatabaseError && !visibleDatabaseCanSave" class="text-xs text-destructive">
        {{ t("visibleDatabases.emptySelection") }}
      </p>

      <label v-if="visibleDatabaseHasSystemObjects" class="flex h-7 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground cursor-pointer">
        <input v-model="visibleDatabaseShowSystem" type="checkbox" class="h-3.5 w-3.5 accent-primary" :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError" />
        <span>{{ t("visibleDatabases.showSystemDatabases") }}</span>
      </label>

      <div class="h-64 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoadingVisibleDatabases" class="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="visibleDatabaseError" class="p-3 text-xs text-destructive leading-5">
          {{ t("visibleDatabases.loadFailed", { message: visibleDatabaseError }) }}
        </div>
        <div v-else-if="!filteredVisibleDatabaseNames.length" class="p-3 text-xs text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
        <template v-else>
          <button v-for="database in filteredVisibleDatabaseNames" :key="database" type="button" class="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground" @click="toggleVisibleDatabase(database)">
            <CheckSquare v-if="visibleDatabaseSelection.has(database)" class="h-3.5 w-3.5 shrink-0 text-primary" />
            <Square v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ database }}</span>
          </button>
        </template>
      </div>

      <DialogFooter class="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" class="h-8 text-xs" @click="showVisibleDatabasesDialog = false">{{ t("common.cancel") }}</Button>
        <Button type="button" size="sm" class="h-8 text-xs" :disabled="isLoadingVisibleDatabases || !!visibleDatabaseError || !visibleDatabaseCanSave" @click="saveVisibleDatabaseSelection">
          {{ t("visibleDatabases.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- Production Databases Dialog -->
  <Dialog :open="showProductionDatabasesDialog" @update:open="showProductionDatabasesDialog = $event">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("production.databasePickerTitle") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">
          {{ t("production.databasePickerDescription", { connection: form.name || form.host || "openGauss" }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="productionDatabaseSearchText" :placeholder="t('production.databaseSearchPlaceholder')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0 text-xs" :disabled="isLoadingProductionDatabases || !!productionDatabaseError" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ t("production.databasesSelectedCount", { selected: productionDatabaseSelectedCount, total: productionDatabaseNames.length }) }}</span>
        <div class="flex items-center gap-2">
          <button type="button" class="hover:text-foreground disabled:opacity-50 text-xs" :disabled="isLoadingProductionDatabases || !!productionDatabaseError" @click="selectAllProductionDatabases">
            {{ t("visibleDatabases.selectAll") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50 text-xs" :disabled="isLoadingProductionDatabases || !!productionDatabaseError" @click="clearProductionDatabaseSelection">
            {{ t("visibleDatabases.clear") }}
          </button>
        </div>
      </div>

      <div class="h-64 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoadingProductionDatabases" class="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="productionDatabaseError" class="p-3 text-xs text-destructive leading-5">
          {{ t("production.databaseLoadFailed", { message: productionDatabaseError }) }}
        </div>
        <div v-else-if="!filteredProductionDatabaseNames.length" class="p-3 text-xs text-muted-foreground">
          {{ productionDatabaseNames.length ? t("grid.noSearchResults") : t("production.noDatabasesAvailable") }}
        </div>
        <template v-else>
          <button v-for="database in filteredProductionDatabaseNames" :key="database" type="button" class="flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground" @click="toggleProductionDatabase(database)">
            <CheckSquare v-if="productionDatabaseSelection.has(database)" class="h-3.5 w-3.5 shrink-0 text-primary" />
            <Square v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ database }}</span>
          </button>
        </template>
      </div>

      <DialogFooter class="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" class="h-8 text-xs" @click="showProductionDatabasesDialog = false">{{ t("common.cancel") }}</Button>
        <Button type="button" size="sm" class="h-8 text-xs" :disabled="isLoadingProductionDatabases || !!productionDatabaseError || !productionDatabaseCanSave" @click="saveProductionDatabaseSelection">
          {{ t("visibleDatabases.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
