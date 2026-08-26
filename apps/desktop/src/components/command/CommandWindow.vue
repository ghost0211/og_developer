<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Loader2, Play, Terminal, Trash2 } from "@lucide/vue";

import { Button } from "@/components/ui/button";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import type { DatabaseType, QueryResult } from "@/types/database";
import * as api from "@/lib/backend/api";

const props = defineProps<{
  tabId: string;
  connectionId: string;
  database: string;
  schema?: string;
  databaseType?: DatabaseType;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

interface CommandLogEntry {
  id: string;
  timestamp: string;
  command: string;
  type: "meta" | "sql" | "system" | "error" | "info";
  result?: QueryResult;
  textOutput?: string;
  elapsedMs?: number;
  error?: string;
}

const currentInput = ref("");
const logs = ref<CommandLogEntry[]>([]);
const connecting = ref(true);
const executing = ref(false);
const showTiming = ref(true);
const historyIndex = ref(-1);
const commandHistory = ref<string[]>([]);
const terminalContainerRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const commandConnections = computed(() => connectionStore.connections.filter((candidate) => candidate.db_type === "opengauss" || candidate.db_type === "gaussdb"));
const currentDbUser = computed(() => connection.value?.username || "omm");
const currentDatabase = computed(() => props.database || connection.value?.database || "postgres");
const currentSchema = computed(() => props.schema?.trim() || "public");
const promptPrefix = computed(() => `${currentDbUser.value}@${currentDatabase.value}=#`);

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.toLowerCase();
}

function qualifiedTableParts(input: string): { schema: string; table: string } {
  const cleaned = input.trim().replace(/;$/, "");
  const separator = cleaned.lastIndexOf(".");
  if (separator <= 0) return { schema: currentSchema.value, table: unquoteIdentifier(cleaned) };
  return {
    schema: unquoteIdentifier(cleaned.slice(0, separator)),
    table: unquoteIdentifier(cleaned.slice(separator + 1)),
  };
}

function scrollToBottom() {
  nextTick(() => {
    if (terminalContainerRef.value) {
      terminalContainerRef.value.scrollTop = terminalContainerRef.value.scrollHeight;
    }
  });
}

function formatAsciiTable(result: QueryResult): string {
  if (!result.columns || result.columns.length === 0) {
    return result.affected_rows != null ? t("commandWindow.rowsAffected", { count: result.affected_rows }) : t("commandWindow.ok");
  }

  const columns = result.columns;
  const rows = result.rows;

  // Compute column widths
  const colWidths = columns.map((col, cIdx) => {
    let max = col.length;
    for (const r of rows) {
      const val = r[cIdx] == null ? t("commandWindow.nullValue") : String(r[cIdx]);
      if (val.length > max) max = Math.min(60, val.length);
    }
    return max;
  });

  const sepLine = "+" + colWidths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const headerLine = "| " + columns.map((col, i) => col.padEnd(colWidths[i])).join(" | ") + " |";

  const lines: string[] = [sepLine, headerLine, sepLine];

  for (const r of rows) {
    const rowLine =
      "| " +
      r
        .map((cell, i) => {
          const str = cell == null ? t("commandWindow.nullValue") : String(cell);
          const truncated = str.length > 60 ? str.slice(0, 57) + "..." : str;
          return truncated.padEnd(colWidths[i]);
        })
        .join(" | ") +
      " |";
    lines.push(rowLine);
  }

  lines.push(sepLine);
  lines.push(rows.length === 1 ? t("commandWindow.rowCountOne") : t("commandWindow.rowCount", { count: rows.length }));

  return lines.join("\n");
}

async function handleMetaCommand(cmd: string): Promise<string | QueryResult> {
  const parts = cmd.trim().split(/\s+/);
  const main = parts[0].toLowerCase();
  const arg = parts[1] || "";
  const boundSchema = props.schema?.trim() || "";
  const schema = currentSchema.value;
  // 未绑定 schema（从菜单直接打开）时按用户 schema 全量列出；系统 schema 清单与
  // 对象树的 isSystemSchemaName（openGauss 规则）保持一致。
  const userSchemaCondition = `n.nspname NOT IN ('blockchain','coverage','cstore','db4ai','dbe_perf','dbe_pldebugger','dbe_pldeveloper','dbe_sql_util','information_schema','pg_catalog','pg_toast','pkg_service','snapshot','sqladvisor','xmltype') AND n.nspname NOT LIKE 'dbe\\_%' AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_%'`;
  const schemaCondition = boundSchema ? `n.nspname = ${sqlStringLiteral(boundSchema)}` : userSchemaCondition;

  switch (main) {
    case "\\?":
    case "help":
      return [
        `===================== ${t("commandWindow.helpTitle")} =====================`,
        `  \\d [table]         ${t("commandWindow.describe")}`,
        `  \\dt                ${t("commandWindow.listTables")}`,
        `  \\dv                ${t("commandWindow.listViews")}`,
        `  \\df [name]         ${t("commandWindow.listFunctions")}`,
        `  \\dn                ${t("commandWindow.listSchemas")}`,
        `  \\di                ${t("commandWindow.listIndexes")}`,
        `  \\ds                ${t("commandWindow.listSequences")}`,
        `  \\du                ${t("commandWindow.listRoles")}`,
        `  \\c <dbname>        ${t("commandWindow.connect")}`,
        `  \\timing [on|off]   ${t("commandWindow.timing")}`,
        `  \\l                 ${t("commandWindow.listDatabases")}`,
        `  \\dx                ${t("commandWindow.listExtensions")}`,
        `  DESC <table_name>  ${t("commandWindow.describeSqlPlus")}`,
        `  SHOW ERRORS        ${t("commandWindow.showErrors")}`,
        `  SHOW USER          ${t("commandWindow.showUser")}`,
        `  clear / cls        ${t("commandWindow.clearScreen")}`,
        `  <SQL Statement>;   ${t("commandWindow.executeSql")}`,
        "==================================================================",
      ].join("\n");

    case "clear":
    case "cls":
      logs.value = [];
      return "";

    case "\\timing": {
      if (arg.toLowerCase() === "off") {
        showTiming.value = false;
        return t("commandWindow.timingOff");
      }
      showTiming.value = true;
      return t("commandWindow.timingOn");
    }

    case "show": {
      if (arg.toLowerCase() === "user") {
        return t("commandWindow.userIs", { user: currentDbUser.value });
      }
      if (arg.toLowerCase() === "errors") {
        const sql = `SELECT s.name AS "Name", s.type AS "Type", e.line AS "Line", e.src AS "Message" \
                     FROM dbe_pldeveloper.gs_errors e \
                     JOIN dbe_pldeveloper.gs_source s ON s.id = e.id \
                     JOIN pg_catalog.pg_namespace n ON n.oid = s.nspid \
                     WHERE ${schemaCondition} ORDER BY s.name, e.line LIMIT 10`;
        return await api.executeQuery(props.connectionId, props.database, sql, schema);
      }
      break;
    }

    case "\\dt": {
      const sql = `SELECT n.nspname AS "Schema", c.relname AS "Name", 'table' AS "Type", pg_catalog.pg_get_userbyid(c.relowner) AS "Owner" \
                   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                   WHERE c.relkind IN ('r', 'p', 'f') AND ${schemaCondition} \
                   ORDER BY 1, 2`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\dv": {
      const sql = `SELECT n.nspname AS "Schema", c.relname AS "Name", 'view' AS "Type", pg_catalog.pg_get_userbyid(c.relowner) AS "Owner" \
                   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                   WHERE c.relkind IN ('v', 'm') AND ${schemaCondition} \
                   ORDER BY 1, 2`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\df": {
      const functionTarget = arg.includes(".") ? qualifiedTableParts(arg) : undefined;
      const functionName = functionTarget?.table || arg;
      const nameFilter = functionName ? `AND p.proname ILIKE '%${functionName.replace(/'/g, "''")}%'` : "";
      // 指定了 schema 前缀（schema.name）则按指定 schema 过滤，否则沿用窗口的 schema 规则。
      const functionSchemaCondition = functionTarget ? `n.nspname = ${sqlStringLiteral(functionTarget.schema)}` : schemaCondition;
      const sql = `SELECT n.nspname AS "Schema", p.proname AS "Name", \
                          pg_catalog.pg_get_function_result(p.oid) AS "Result data type", \
                          pg_catalog.pg_get_function_arguments(p.oid) AS "Argument data types", \
                          CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS "Type" \
                   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
                   WHERE ${functionSchemaCondition} ${nameFilter} \
                   ORDER BY 1, 2`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\dn": {
      const sql = `SELECT n.nspname AS "Name", pg_catalog.pg_get_userbyid(n.nspowner) AS "Owner" \
                   FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%' ORDER BY 1`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\l": {
      const sql = `SELECT datname AS "Name", pg_catalog.pg_get_userbyid(datdba) AS "Owner", pg_encoding_to_char(encoding) AS "Encoding" \
                   FROM pg_catalog.pg_database WHERE datallowconn ORDER BY 1`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\dx": {
      const sql = `SELECT extname AS "Name", extversion AS "Version", extrelocatable AS "Relocatable" \
                   FROM pg_catalog.pg_extension ORDER BY 1`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\di": {
      const sql = `SELECT n.nspname AS "Schema", c.relname AS "Name", c2.relname AS "Table", pg_catalog.pg_get_userbyid(c.relowner) AS "Owner" \
                   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                   JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid JOIN pg_catalog.pg_class c2 ON c2.oid = i.indrelid \
                   WHERE c.relkind = 'i' AND ${schemaCondition} ORDER BY 1, 3, 2`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\ds": {
      const sql = `SELECT n.nspname AS "Schema", c.relname AS "Name", 'sequence' AS "Type", pg_catalog.pg_get_userbyid(c.relowner) AS "Owner" \
                   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                   WHERE c.relkind = 'S' AND ${schemaCondition} ORDER BY 1, 2`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "\\du":
    case "\\dg": {
      const sql = `SELECT r.rolname AS "Role name", \
                          r.rolsuper AS "Superuser", \
                          r.rolcreaterole AS "Create role", \
                          r.rolcreatedb AS "Create DB", \
                          r.rolcanlogin AS "Can login" \
                   FROM pg_catalog.pg_roles r ORDER BY 1`;
      return await api.executeQuery(props.connectionId, props.database, sql, schema);
    }

    case "desc":
    case "describe":
    case "\\d": {
      if (!arg) {
        // Run general \dt if no argument
        return await handleMetaCommand("\\dt");
      }
      const target = arg.replace(/;/g, "").trim();
      const targetParts = qualifiedTableParts(target);
      // 未绑定 schema 且未限定 schema 时，先在用户 schema 中定位对象
      // （优先当前用户同名 schema，其次 public，其余按名称排序）。
      let describeSchema = targetParts.schema;
      if (!boundSchema && !target.includes(".")) {
        const locate = await api.executeQuery(
          props.connectionId,
          props.database,
          `SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
           WHERE c.relname = ${sqlStringLiteral(targetParts.table)} AND ${userSchemaCondition} \
           ORDER BY CASE WHEN n.nspname = current_user THEN 0 WHEN n.nspname = 'public' THEN 1 ELSE 2 END, 1 LIMIT 1`,
          schema,
        );
        if (locate.rows.length > 0) describeSchema = String(locate.rows[0][0]);
      }
      const sql = `SELECT column_name AS "Column", data_type AS "Type", is_nullable AS "Nullable", column_default AS "Default" \
                   FROM information_schema.columns \
                   WHERE table_schema = ${sqlStringLiteral(describeSchema)} AND table_name = ${sqlStringLiteral(targetParts.table)} \
                   ORDER BY ordinal_position`;
      const res = await api.executeQuery(props.connectionId, props.database, sql, schema);
      if (res.rows.length === 0) {
        return t("commandWindow.relationNotFound", { name: target });
      }
      return res;
    }

    case "\\c": {
      if (arg) {
        queryStore.updateDatabase(props.tabId, arg);
        return t("commandWindow.connectedMessage", { database: arg, user: currentDbUser.value });
      }
      return t("commandWindow.currentDatabase", { database: currentDatabase.value });
    }
  }

  return "";
}

async function executeCommand() {
  const raw = currentInput.value.trim();
  if (!raw || connecting.value || executing.value) return;

  // Add to history
  commandHistory.value.push(raw);
  historyIndex.value = commandHistory.value.length;
  currentInput.value = "";
  executing.value = true;

  const entryId = Math.random().toString(36).slice(2);
  const timeStr = new Date().toLocaleTimeString();
  const startTime = performance.now();

  try {
    const lowerRaw = raw.toLowerCase();
    const normalizedMetaCommand = lowerRaw.replace(/;\s*$/, "").trim();
    const commandForMeta = raw.replace(/;\s*$/, "").trim();
    const isMeta = raw.startsWith("\\") || /^(desc|describe)(\s|$)/.test(normalizedMetaCommand) || normalizedMetaCommand === "help" || normalizedMetaCommand === "clear" || normalizedMetaCommand === "cls" || normalizedMetaCommand === "show errors" || normalizedMetaCommand === "show user";

    if (isMeta) {
      const metaRes = await handleMetaCommand(commandForMeta);
      const elapsed = Math.round(performance.now() - startTime);

      if (normalizedMetaCommand === "clear" || normalizedMetaCommand === "cls") {
        executing.value = false;
        return;
      }

      if (typeof metaRes === "string") {
        logs.value.push({
          id: entryId,
          timestamp: timeStr,
          command: raw,
          type: "meta",
          textOutput: metaRes,
          elapsedMs: elapsed,
        });
      } else {
        logs.value.push({
          id: entryId,
          timestamp: timeStr,
          command: raw,
          type: "meta",
          result: metaRes,
          textOutput: formatAsciiTable(metaRes),
          elapsedMs: elapsed,
        });
      }
    } else {
      // Regular SQL execution
      const schema = currentSchema.value;
      const cleanSql = raw.endsWith("/") ? raw.slice(0, -1).trim() : raw;
      const result = await api.executeQuery(props.connectionId, props.database, cleanSql, schema);
      const elapsed = Math.round(performance.now() - startTime);

      logs.value.push({
        id: entryId,
        timestamp: timeStr,
        command: raw,
        type: "sql",
        result,
        textOutput: formatAsciiTable(result),
        elapsedMs: elapsed,
      });
    }
  } catch (err: any) {
    const elapsed = Math.round(performance.now() - startTime);
    const msg = err?.message || String(err);
    logs.value.push({
      id: entryId,
      timestamp: timeStr,
      command: raw,
      type: "error",
      error: msg,
      elapsedMs: elapsed,
    });
  } finally {
    executing.value = false;
    scrollToBottom();
  }
}

function isPlsqlBlock(text: string): boolean {
  return /^(declare|begin|create\s+(or\s+replace\s+)?(procedure|function|package))\b/i.test(text.trim());
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    const text = currentInput.value;
    const trimmed = text.trim();
    const submitWithModifier = event.ctrlKey || event.metaKey;
    const completeSlashTerminatedBlock = /(?:^|\n)\s*\/\s*$/.test(trimmed);
    const submitSingleLine = !event.shiftKey && !text.includes("\n") && !isPlsqlBlock(text);
    if (submitWithModifier || completeSlashTerminatedBlock || submitSingleLine) {
      event.preventDefault();
      void executeCommand();
    }
    return;
  }

  if (event.key === "ArrowUp") {
    if (historyIndex.value > 0) {
      event.preventDefault();
      historyIndex.value--;
      currentInput.value = commandHistory.value[historyIndex.value] || "";
    }
    return;
  }

  if (event.key === "ArrowDown") {
    if (historyIndex.value < commandHistory.value.length - 1) {
      event.preventDefault();
      historyIndex.value++;
      currentInput.value = commandHistory.value[historyIndex.value] || "";
    } else {
      event.preventDefault();
      historyIndex.value = commandHistory.value.length;
      currentInput.value = "";
    }
  }
}

function quickRun(cmd: string) {
  currentInput.value = cmd;
  void executeCommand();
}

async function copyAllOutput() {
  const text = logs.value
    .map((l) => {
      const header = `${promptPrefix.value} ${l.command}`;
      const body = l.error ? `ERROR: ${l.error}` : l.textOutput || "";
      const time = l.elapsedMs != null && showTiming.value ? t("commandWindow.time", { ms: l.elapsedMs }) : "";
      return [header, body, time].filter(Boolean).join("\n");
    })
    .join("\n\n");

  await copyToClipboard(text);
  toast(t("commandWindow.copied"), 1500);
}

function clearTerminal() {
  logs.value = [];
}

// 数据库下拉选项：跟随当前连接加载，失败时回退到连接配置的数据库。
const databases = ref<string[]>([]);

async function loadDatabaseOptions() {
  const config = connection.value;
  if (!props.connectionId || !config) {
    databases.value = [];
    return;
  }
  try {
    const rows = await api.listDatabases(props.connectionId);
    databases.value = databaseOptionsForConnection(
      rows.map((row) => row.name),
      config,
    );
  } catch (error) {
    console.warn("[CommandWindow] failed to load database options", error);
    databases.value = config.database ? [config.database] : [];
  }
}

// 切换数据库无需重建会话：数据库作为查询参数随 executeQuery 生效。
function onDatabaseSelected(event: Event) {
  const database = (event.target as HTMLSelectElement).value;
  if (!database || database === currentDatabase.value) return;
  queryStore.setCommandTabDatabase(props.tabId, database);
  logs.value.push({
    id: Math.random().toString(36).slice(2),
    timestamp: new Date().toLocaleTimeString(),
    command: "",
    type: "info",
    textOutput: t("commandWindow.switchedDatabase", { database }),
  });
  inputRef.value?.focus();
  scrollToBottom();
}

async function initializeCommandWindow() {
  logs.value.push({
    id: "welcome",
    timestamp: new Date().toLocaleTimeString(),
    command: "",
    type: "info",
    textOutput: [`${t("commandWindow.title")} (openGauss)`, t("commandWindow.connectedBanner", { name: connection.value?.name || "openGauss", database: currentDatabase.value, user: currentDbUser.value }), t("commandWindow.welcomeHint")].join("\n"),
  });
  try {
    await connectionStore.ensureConnected(props.connectionId, { activate: false });
    logs.value.push({
      id: "connected",
      timestamp: new Date().toLocaleTimeString(),
      command: "",
      type: "info",
      textOutput: t("commandWindow.connectedTo", { database: currentDatabase.value }),
    });
    await loadDatabaseOptions();
  } catch (error: any) {
    logs.value.push({
      id: "connection-error",
      timestamp: new Date().toLocaleTimeString(),
      command: "",
      type: "error",
      error: error?.message || String(error),
    });
  } finally {
    connecting.value = false;
    inputRef.value?.focus();
    scrollToBottom();
  }
}

onMounted(() => {
  void initializeCommandWindow();
});

// 在命令窗口内切换连接：标签绑定变更后重建会话，保留历史输出。
watch(
  () => props.connectionId,
  async (connectionId, previousId) => {
    if (!previousId || connectionId === previousId) return;
    connecting.value = true;
    logs.value.push({
      id: Math.random().toString(36).slice(2),
      timestamp: new Date().toLocaleTimeString(),
      command: "",
      type: "info",
      textOutput: t("commandWindow.switchedTo", { name: connection.value?.name || "openGauss", database: currentDatabase.value }),
    });
    try {
      await connectionStore.ensureConnected(connectionId, { activate: false });
      logs.value.push({
        id: Math.random().toString(36).slice(2),
        timestamp: new Date().toLocaleTimeString(),
        command: "",
        type: "info",
        textOutput: t("commandWindow.connectedTo", { database: currentDatabase.value }),
      });
      await loadDatabaseOptions();
    } catch (error: any) {
      logs.value.push({
        id: Math.random().toString(36).slice(2),
        timestamp: new Date().toLocaleTimeString(),
        command: "",
        type: "error",
        error: error?.message || String(error),
      });
    } finally {
      connecting.value = false;
      inputRef.value?.focus();
      scrollToBottom();
    }
  },
);
</script>

<template>
  <div class="flex h-full w-full flex-col min-h-0 bg-background text-foreground font-mono text-xs select-text">
    <!-- Action Bar -->
    <div class="flex flex-wrap items-center justify-between border-b bg-muted/40 px-3 py-1.5 shrink-0 select-none gap-2">
      <!-- Left: Prompt Info & Quick Commands -->
      <div class="flex items-center gap-1.5 overflow-x-auto flex-1">
        <div class="flex items-center gap-1.5 text-xs text-foreground font-bold mr-1 shrink-0">
          <Terminal class="h-4 w-4 text-emerald-500" />
          <select
            :value="props.connectionId"
            class="h-6 max-w-[150px] rounded border bg-background px-1.5 text-xs font-normal outline-none"
            :aria-label="t('commandWindow.connection')"
            :disabled="connecting || executing"
            @change="queryStore.retargetCommandTab(props.tabId, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="c in commandConnections" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <select :value="currentDatabase" class="h-6 max-w-[130px] rounded border bg-background px-1.5 text-xs font-normal outline-none" :aria-label="t('commandWindow.database')" :disabled="connecting || executing" @change="onDatabaseSelected">
            <option v-for="d in databases" :key="d" :value="d">{{ d }}</option>
            <option v-if="!databases.includes(currentDatabase)" :value="currentDatabase">{{ currentDatabase }}</option>
          </select>
        </div>

        <!-- Quick Chips -->
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground" @click="quickRun('\\dt')"> \dt ({{ t("commandWindow.quickTables") }}) </Button>
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground" @click="quickRun('\\dv')"> \dv ({{ t("commandWindow.quickViews") }}) </Button>
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground" @click="quickRun('\\df')"> \df ({{ t("commandWindow.quickFunctions") }}) </Button>
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground" @click="quickRun('\\dn')"> \dn ({{ t("commandWindow.quickSchemas") }}) </Button>
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground" @click="quickRun('SHOW ERRORS')"> SHOW ERRORS </Button>
        <Button variant="ghost" size="sm" class="h-6 px-1.5 text-[11px] font-mono text-muted-foreground hover:text-foreground" @click="quickRun('help')"> \? ({{ t("commandWindow.quickHelp") }}) </Button>
      </div>

      <!-- Right: Controls -->
      <div class="flex items-center gap-1 shrink-0 font-sans">
        <label class="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer mr-2 select-none">
          <input v-model="showTiming" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
          <span>{{ t("commandWindow.timingLabel") }}</span>
        </label>

        <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs" :title="t('commandWindow.copyTitle')" @click="copyAllOutput">
          <Copy class="h-3 w-3" />
          <span>{{ t("commandWindow.copy") }}</span>
        </Button>

        <Button variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive" :title="t('commandWindow.clearTitle')" @click="clearTerminal">
          <Trash2 class="h-3 w-3" />
          <span>{{ t("commandWindow.clear") }}</span>
        </Button>
      </div>
    </div>

    <!-- Terminal Output Log Stream -->
    <div ref="terminalContainerRef" class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 bg-background font-mono leading-relaxed">
      <div v-for="entry in logs" :key="entry.id" class="space-y-1">
        <!-- Command Header -->
        <div v-if="entry.command" class="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-semibold select-text">
          <span>{{ promptPrefix }}</span>
          <span class="text-foreground">{{ entry.command }}</span>
        </div>

        <!-- Output Body -->
        <div v-if="entry.error" class="text-destructive font-sans whitespace-pre-wrap pl-2 border-l-2 border-destructive/60 my-1 py-0.5">
          {{ entry.error }}
        </div>

        <pre v-else-if="entry.textOutput" class="whitespace-pre overflow-x-auto text-foreground/90 py-0.5 font-mono text-[11.5px] leading-snug select-text">{{ entry.textOutput }}</pre>

        <!-- Elapsed timing footer -->
        <div v-if="entry.elapsedMs != null && showTiming && entry.type !== 'info'" class="text-[10px] text-muted-foreground/60 select-none">{{ t("commandWindow.time", { ms: entry.elapsedMs }) }}</div>
      </div>

      <!-- Live connection/execution spinner -->
      <div v-if="connecting" class="flex items-center gap-2 text-muted-foreground py-1">
        <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" />
        <span>{{ t("commandWindow.connecting") }}</span>
      </div>
      <div v-else-if="executing" class="flex items-center gap-2 text-muted-foreground py-1">
        <Loader2 class="h-3.5 w-3.5 animate-spin text-primary" />
        <span>{{ t("commandWindow.executing") }}</span>
      </div>
    </div>

    <!-- Input Footer Bar -->
    <div class="border-t bg-muted/20 p-2 flex items-start gap-2 shrink-0">
      <div class="font-bold text-emerald-600 dark:text-emerald-400 select-none pl-1 shrink-0 py-1 leading-5">
        {{ promptPrefix }}
      </div>

      <textarea
        ref="inputRef"
        v-model="currentInput"
        rows="1"
        class="max-h-40 min-h-7 flex-1 resize-y bg-transparent border-0 outline-none text-foreground font-mono text-xs leading-5 py-1 placeholder:text-muted-foreground/40 shadow-none focus-visible:ring-0"
        :placeholder="connecting ? t('commandWindow.connecting') : executing ? t('commandWindow.executing') : t('commandWindow.inputPlaceholder')"
        :disabled="connecting || executing"
        autofocus
        @keydown="handleKeydown"
      />

      <Button size="sm" class="h-7 px-3 gap-1 bg-primary text-primary-foreground font-sans text-xs" :disabled="connecting || executing || !currentInput.trim()" @click="executeCommand">
        <Play class="h-3 w-3 fill-current" />
        <span>{{ t("commandWindow.execute") }}</span>
      </Button>
    </div>
  </div>
</template>
