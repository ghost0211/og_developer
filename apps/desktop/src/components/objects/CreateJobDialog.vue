<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CalendarClock, Check, Code2, Copy, FileCode, Loader2, Play, Timer, Clock } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import type { DatabaseType } from "@/types/database";

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
  databaseType?: DatabaseType;
  initialMode?: "job" | "scheduler";
  isEdit?: boolean;
  editName?: string;
}>();

const emit = defineEmits<{
  created: [mode: "job" | "scheduler", nameOrId: string];
  openInEditor: [sql: string];
}>();

const { t } = useI18n();
const { toast } = useToast();

const isEditMode = computed(() => !!props.isEdit || !!props.editName);
const isLoadingDetails = ref(false);

const mode = ref<"job" | "scheduler">("job");
const jobName = ref("");
const targetSchema = ref("public");
const enabled = ref(true);
const actionType = ref<"PLSQL_BLOCK" | "STORED_PROCEDURE" | "SQL">("PLSQL_BLOCK");
const actionContent = ref("CALL public.my_procedure();");

const startDatePreset = ref("sysdate");
const customStartDate = ref("sysdate");

const intervalPreset = ref("sysdate + 1/1440");
const customInterval = ref("sysdate + 1/1440");

const isExecuting = ref(false);
const executionError = ref("");
const copied = ref(false);

const intervalPresets = [
  { label: "每 1 分钟 (Every 1 min)", value: "sysdate + 1/1440" },
  { label: "每 5 分钟 (Every 5 mins)", value: "sysdate + 5/1440" },
  { label: "每 10 分钟 (Every 10 mins)", value: "sysdate + 10/1440" },
  { label: "每 30 分钟 (Every 30 mins)", value: "sysdate + 30/1440" },
  { label: "每 1 小时 (Every 1 hour)", value: "sysdate + 1/24" },
  { label: "每天 (当前时间)", value: "sysdate + 1" },
  { label: "每天凌晨 00:00", value: "TRUNC(sysdate + 1)" },
  { label: "每天凌晨 01:00", value: "TRUNC(sysdate + 1) + 1/24" },
  { label: "每周一次", value: "sysdate + 7" },
  { label: "每月一次", value: "ADD_MONTHS(sysdate, 1)" },
  { label: "仅执行一次 (null)", value: "null" },
  { label: "自定义表达式 (Custom)", value: "custom" },
];

const startDatePresets = [
  { label: "立即执行 (sysdate)", value: "sysdate" },
  { label: "1 小时后", value: "sysdate + 1/24" },
  { label: "明日凌晨 00:00", value: "TRUNC(sysdate + 1)" },
  { label: "明日凌晨 01:00", value: "TRUNC(sysdate + 1) + 1/24" },
  { label: "自定义表达式", value: "custom" },
];

async function loadJobDetails(name: string) {
  if (!props.connectionId || !props.database) return;
  isLoadingDetails.value = true;
  executionError.value = "";
  try {
    const escaped = escapeSqlString(name);
    const sql = `SELECT j.job_id, j.job_name, j.nspname, p.what, j.interval, j.next_run_date, j.start_date, j.enable, j.job_status FROM pg_catalog.pg_job j LEFT JOIN pg_catalog.pg_job_proc p ON j.job_id = p.job_id WHERE (j.job_name = '${escaped}' OR j.job_id::text = '${escaped}') LIMIT 1;`;
    const result = await api.executeQuery(props.connectionId, props.database, sql);
    if (result?.rows?.[0]) {
      const [jobId, jName, nsp, what, interval, nextRun, _start, isEn, jobStat] = result.rows[0];
      const hasJobName = jName !== null && jName !== undefined && String(jName).trim() !== "";
      mode.value = hasJobName ? "scheduler" : "job";
      jobName.value = hasJobName ? String(jName) : String(jobId);
      targetSchema.value = nsp ? String(nsp) : props.schema || "public";
      actionContent.value = what ? String(what) : "";
      enabled.value = String(jobStat) !== "d" && (isEn === true || String(isEn).toLowerCase() === "true" || String(jobStat) === "s");

      const intervalStr = interval ? String(interval).trim() : "null";
      const foundInterval = intervalPresets.find((p) => p.value.toLowerCase() === intervalStr.toLowerCase());
      if (foundInterval) {
        intervalPreset.value = foundInterval.value;
        customInterval.value = foundInterval.value;
      } else {
        intervalPreset.value = "custom";
        customInterval.value = intervalStr;
      }

      const nextRunStr = nextRun ? String(nextRun) : "sysdate";
      startDatePreset.value = "custom";
      customStartDate.value = nextRunStr;
    }
  } catch (err: any) {
    executionError.value = translateBackendError(t, err) || String(err);
  } finally {
    isLoadingDetails.value = false;
  }
}

watch(
  () => [open.value, props.initialMode, props.schema, props.editName, props.isEdit] as const,
  ([isOpen, initialMode, initialSchema, editName, isEdit]) => {
    if (isOpen) {
      if (isEdit || editName) {
        if (editName) {
          void loadJobDetails(editName);
        }
      } else {
        mode.value = initialMode === "scheduler" ? "scheduler" : "job";
        targetSchema.value = initialSchema || "public";
        jobName.value = mode.value === "scheduler" ? "NEW_SCHEDULER_JOB" : "";
        actionContent.value = "CALL public.my_procedure();";
        enabled.value = true;
        startDatePreset.value = "sysdate";
        customStartDate.value = "sysdate";
        intervalPreset.value = "sysdate + 1/1440";
        customInterval.value = "sysdate + 1/1440";
        executionError.value = "";
      }
    }
  },
  { immediate: true },
);

watch(startDatePreset, (val) => {
  if (val !== "custom") {
    customStartDate.value = val;
  }
});

watch(intervalPreset, (val) => {
  if (val !== "custom") {
    customInterval.value = val;
  }
});

function handleIntervalPresetChange(val: any) {
  const str = String(val ?? "");
  intervalPreset.value = str;
  if (str !== "custom") {
    customInterval.value = str;
  }
}

function handleStartDatePresetChange(val: any) {
  const str = String(val ?? "");
  startDatePreset.value = str;
  if (str !== "custom") {
    customStartDate.value = str;
  }
}

const effectiveStartDate = computed(() => {
  return startDatePreset.value === "custom" ? customStartDate.value.trim() : startDatePreset.value;
});

const effectiveInterval = computed(() => {
  return intervalPreset.value === "custom" ? customInterval.value.trim() : intervalPreset.value;
});

function escapeSqlString(str: string): string {
  return str.replace(/'/g, "''");
}

const generatedSql = computed(() => {
  const schema = targetSchema.value.trim() || "public";
  const action = actionContent.value.trim() || "NULL;";
  const start = effectiveStartDate.value || "sysdate";
  const interval = effectiveInterval.value || "null";
  const name = jobName.value.trim() || (mode.value === "scheduler" ? "MY_SCHEDULER_JOB" : "1001");
  const isEnabledStr = enabled.value ? "true" : "false";

  if (isEditMode.value) {
    if (mode.value === "job") {
      return (
        `-- openGauss 修改经典作业 (Classic Job via pkg_service)\n` +
        `SET current_schema = ${schema};\n\n` +
        `SELECT pkg_service.job_update(\n` +
        `    ${name},                                       -- Job ID\n` +
        `    ${start},                                      -- 下次执行时间 (next_time)\n` +
        `    '${escapeSqlString(interval)}',                -- 执行间隔 (interval_time)\n` +
        `    '${escapeSqlString(action)}'                   -- 执行内容 (content)\n` +
        `);\n` +
        `SELECT pkg_service.job_finish(${name}, ${enabled.value ? "false" : "true"}${enabled.value ? ", " + start : ""});\n`
      );
    }

    return (
      `-- openGauss 修改调度配置 (DBMS_SCHEDULER)\n` +
      `SET current_schema = ${schema};\n\n` +
      `CALL dbms_scheduler.update_job(\n` +
      `    p_job_name_or_id  => '${escapeSqlString(name)}',\n` +
      `    p_job_action      => '${escapeSqlString(action)}',\n` +
      `    p_repeat_interval => '${escapeSqlString(interval)}',\n` +
      `    p_enabled         => ${isEnabledStr}\n` +
      `);\n`
    );
  }

  if (mode.value === "job") {
    return (
      `-- openGauss 经典作业 (Classic Job via pkg_service)\n` +
      `SET current_schema = ${schema};\n\n` +
      `SELECT pkg_service.job_submit(\n` +
      `  NULL,                                       -- 自动生成 Job ID\n` +
      `  '${escapeSqlString(action)}',\n` +
      `  ${start},\n` +
      `  '${escapeSqlString(interval)}'\n` +
      `);\n`
    );
  }

  return (
    `-- openGauss 高级调度 (DBMS_SCHEDULER)\n` +
    `SET current_schema = ${schema};\n\n` +
    `CALL dbms_scheduler.create_job(\n` +
    `    p_job_name        => '${escapeSqlString(name)}',\n` +
    `    p_job_type        => '${actionType.value}',\n` +
    `    p_job_action      => '${escapeSqlString(action)}',\n` +
    `    p_start_date      => ${start},\n` +
    `    p_repeat_interval => '${escapeSqlString(interval)}',\n` +
    `    p_enabled         => ${isEnabledStr}\n` +
    `);\n`
  );
});

async function copySql() {
  try {
    await navigator.clipboard.writeText(generatedSql.value);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
    toast(t("sqlDialog.copied") || "SQL 已复制到剪贴板");
  } catch {
    // ignore
  }
}

function handleOpenInEditor() {
  emit("openInEditor", generatedSql.value);
  open.value = false;
}

async function handleApply() {
  if (mode.value === "scheduler" && !jobName.value.trim()) {
    executionError.value = "请输入调度名称 (Job Name)";
    return;
  }
  if (!actionContent.value.trim()) {
    executionError.value = "请输入作业要执行的内容";
    return;
  }

  isExecuting.value = true;
  executionError.value = "";

  try {
    const schema = targetSchema.value.trim() || "public";
    const action = actionContent.value.trim();
    const start = effectiveStartDate.value || "sysdate";
    const interval = effectiveInterval.value || "null";
    const name = jobName.value.trim();

    if (isEditMode.value) {
      if (mode.value === "job") {
        const changeSql = `SET current_schema = ${schema}; SELECT pkg_service.job_update(${name}, ${start}, '${escapeSqlString(interval)}', '${escapeSqlString(action)}'); SELECT pkg_service.job_finish(${name}, ${enabled.value ? "false" : "true"}${enabled.value ? ", " + start : ""});`;
        await api.executeQuery(props.connectionId, props.database, changeSql);
        toast(t("jobDialog.jobUpdateSuccess", { name }) || `经典作业 #${name} 已保存修改`);
        emit("created", "job", name);
      } else {
        const updateSql = `SET current_schema = ${schema}; CALL dbms_scheduler.update_job('${escapeSqlString(name)}', '${escapeSqlString(action)}', '${escapeSqlString(interval)}', ${enabled.value ? "true" : "false"});`;
        await api.executeQuery(props.connectionId, props.database, updateSql);
        toast(t("jobDialog.jobUpdateSuccess", { name }) || `调度任务 "${name}" 已保存修改`);
        emit("created", "scheduler", name);
      }
    } else if (mode.value === "job") {
      const sql = `SET current_schema = ${schema}; SELECT pkg_service.job_submit(NULL, '${escapeSqlString(action)}', ${start}, '${escapeSqlString(interval)}');`;
      const result = await api.executeQuery(props.connectionId, props.database, sql);
      const newId = String(result?.rows?.[0]?.[0] ?? "");
      toast(t("jobDialog.jobCreateSuccess", { id: newId }) || `经典作业已创建成功 (ID: ${newId})`);
      emit("created", "job", newId);
    } else {
      const createSql = `SET current_schema = ${schema}; CALL dbms_scheduler.create_job('${escapeSqlString(name)}', '${actionType.value}', '${escapeSqlString(action)}', ${start}, '${escapeSqlString(interval)}', ${enabled.value ? "true" : "false"});`;
      await api.executeQuery(props.connectionId, props.database, createSql);
      toast(t("jobDialog.schedulerCreateSuccess", { name }) || `调度任务 "${name}" 创建成功`);
      emit("created", "scheduler", name);
    }

    open.value = false;
  } catch (error: any) {
    executionError.value = translateBackendError(t, error) || error?.message || String(error);
  } finally {
    isExecuting.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl max-h-[85vh] flex flex-col p-6 overflow-hidden relative">
      <!-- 详情加载中遮罩 -->
      <div v-if="isLoadingDetails" class="absolute inset-0 bg-background/75 backdrop-blur-xs flex flex-col items-center justify-center gap-2 z-20">
        <Loader2 class="w-6 h-6 animate-spin text-primary" />
        <span class="text-xs text-muted-foreground">{{ t("common.loading") || "正在加载作业配置..." }}</span>
      </div>

      <DialogHeader class="shrink-0 pb-2">
        <DialogTitle class="flex items-center gap-2 text-base font-semibold">
          <component :is="mode === 'scheduler' ? Timer : CalendarClock" class="w-5 h-5" :class="mode === 'scheduler' ? 'text-amber-500' : 'text-orange-500'" />
          <span v-if="isEditMode">{{ mode === "scheduler" ? t("jobDialog.editSchedulerTitle", { name: jobName }) || `编辑调度 - ${jobName}` : t("jobDialog.editJobTitle", { id: jobName }) || `编辑作业 - #${jobName}` }}</span>
          <span v-else>{{ mode === "scheduler" ? t("jobDialog.createSchedulerTitle") || "新建调度 (DBMS_SCHEDULER)" : t("jobDialog.createJobTitle") || "新建作业 (Classic Job)" }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 overflow-y-auto space-y-4 pr-1">
        <!-- 模式切换 Segmented Control (新建模式下显示) -->
        <div v-if="!isEditMode" class="flex items-center rounded-lg bg-muted p-1 border">
          <button type="button" class="flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-md text-xs font-medium transition-all" :class="mode === 'job' ? 'bg-background shadow-xs text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="mode = 'job'">
            <CalendarClock class="w-4 h-4 text-orange-500" />
            <span>{{ t("jobDialog.classicJobTab") || "经典作业 (pkg_service)" }}</span>
          </button>
          <button type="button" class="flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-md text-xs font-medium transition-all" :class="mode === 'scheduler' ? 'bg-background shadow-xs text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="mode = 'scheduler'">
            <Timer class="w-4 h-4 text-amber-500" />
            <span>{{ t("jobDialog.schedulerTab") || "高级调度 (DBMS_SCHEDULER)" }}</span>
          </button>
        </div>

        <!-- 错误提示 -->
        <div v-if="executionError" class="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-xs text-destructive flex items-start gap-2">
          <span class="font-medium shrink-0">{{ t("common.error") || "错误" }}:</span>
          <span class="break-all">{{ executionError }}</span>
        </div>

        <!-- 基础配置项 -->
        <div class="grid grid-cols-2 gap-4">
          <!-- 任务标识 / 名称 -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <span>{{ t("jobDialog.jobName") || "任务名称 / 标识" }}</span>
              <span v-if="mode === 'scheduler'" class="text-destructive">*</span>
            </label>
            <Input v-if="mode === 'scheduler'" v-model="jobName" placeholder="e.g. DAILY_SYNC_TASK" class="h-8 text-xs font-mono" />
            <div v-else class="h-8 px-3 rounded-md border bg-muted/40 text-xs text-muted-foreground flex items-center">
              {{ t("jobDialog.autoJobIdHint") || "系统自动分配自增 Job ID" }}
            </div>
          </div>

          <!-- 所属模式 Schema -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">
              {{ t("jobDialog.targetSchema") || "所属模式 (Schema)" }}
            </label>
            <Input v-model="targetSchema" placeholder="public" class="h-8 text-xs font-mono" />
          </div>
        </div>

        <div class="grid grid-cols-2 gap-4 items-center">
          <!-- 动作类型 (仅 Scheduler) -->
          <div class="space-y-1.5">
            <label class="text-xs font-medium text-muted-foreground">
              {{ t("jobDialog.actionType") || "作业类型 (Job Type)" }}
            </label>
            <Select v-model="actionType">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PLSQL_BLOCK">PLSQL_BLOCK (PL/SQL 代码块)</SelectItem>
                <SelectItem value="STORED_PROCEDURE">STORED_PROCEDURE (存储过程)</SelectItem>
                <SelectItem value="SQL">SQL (SQL 语句)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <!-- 是否启用 -->
          <div class="flex items-center justify-between pt-4 pr-2">
            <div>
              <div class="text-xs font-medium">{{ t("jobDialog.enabledLabel") || "立即激活 (Enabled)" }}</div>
              <div class="text-[10px] text-muted-foreground">{{ t("jobDialog.enabledDesc") || "创建后按设定周期自动调度" }}</div>
            </div>
            <Switch v-model="enabled" />
          </div>
        </div>

        <!-- 执行内容 (Action) -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <label class="text-xs font-medium text-muted-foreground">
              {{ t("jobDialog.actionContent") || "执行内容 / SQL 逻辑 (Action)" }}
              <span class="text-destructive">*</span>
            </label>
            <span class="text-[10px] text-muted-foreground">{{ t("jobDialog.actionHint") || "推荐使用带 Schema 的全限定调用" }}</span>
          </div>
          <textarea v-model="actionContent" rows="3" class="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring" placeholder="CALL public.my_procedure();" />
        </div>

        <!-- 时间与调度配置 -->
        <div class="p-3 rounded-lg border bg-card space-y-3">
          <div class="text-xs font-semibold flex items-center gap-1.5 text-foreground">
            <Clock class="w-3.5 h-3.5 text-primary" />
            <span>{{ t("jobDialog.scheduleSection") || "调度规则与时间设置" }}</span>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <!-- 首次执行时间 -->
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">
                {{ t("jobDialog.startDate") || "首次执行时间 (Start Date)" }}
              </label>
              <Select :model-value="startDatePreset" @update:model-value="handleStartDatePresetChange">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="item in startDatePresets" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input v-if="startDatePreset === 'custom'" v-model="customStartDate" placeholder="sysdate" class="h-7 text-xs font-mono mt-1" />
            </div>

            <!-- 重复执行周期 / 间隔 -->
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">
                {{ t("jobDialog.repeatInterval") || "重复间隔 (Repeat Interval)" }}
              </label>
              <Select :model-value="intervalPreset" @update:model-value="handleIntervalPresetChange">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="item in intervalPresets" :key="item.value" :value="item.value">
                    {{ item.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <Input v-model="customInterval" placeholder="sysdate + 1/1440" class="h-7 text-xs font-mono mt-1" @input="intervalPreset = 'custom'" />
            </div>
          </div>
        </div>

        <!-- 实时 DDL / SQL 预览 -->
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Code2 class="w-3.5 h-3.5" />
              <span>{{ t("jobDialog.sqlPreview") || "实时 DDL / SQL 预览" }}</span>
            </span>
            <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px] gap-1" @click="copySql">
              <component :is="copied ? Check : Copy" class="w-3 h-3" />
              <span>{{ copied ? t("sqlDialog.copied") || "已复制" : t("common.copy") || "复制" }}</span>
            </Button>
          </div>
          <pre class="p-2.5 rounded-md bg-muted/60 text-[11px] font-mono overflow-x-auto max-h-32 text-muted-foreground border">{{ generatedSql }}</pre>
        </div>
      </div>

      <DialogFooter class="shrink-0 pt-3 border-t mt-3 flex items-center justify-between sm:justify-between">
        <Button variant="outline" size="sm" @click="handleOpenInEditor">
          <FileCode class="w-4 h-4 mr-1.5" />
          <span>{{ t("jobDialog.openInEditor") || "在 SQL 编辑器中打开" }}</span>
        </Button>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" :disabled="isExecuting" @click="open = false">
            {{ t("common.cancel") || "取消" }}
          </Button>
          <Button size="sm" :disabled="isExecuting" @click="handleApply">
            <Loader2 v-if="isExecuting" class="w-4 h-4 mr-1.5 animate-spin" />
            <Play v-else class="w-4 h-4 mr-1.5" />
            <span>{{ isExecuting ? (isEditMode ? t("common.saving") || "正在保存..." : t("common.executing") || "正在创建...") : isEditMode ? t("common.save") || "保存修改" : t("common.create") || "直接创建" }}</span>
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
