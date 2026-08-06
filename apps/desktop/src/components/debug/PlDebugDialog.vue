<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Bug, CirclePlay, Loader2, OctagonX, RefreshCw, StepForward } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import type { OpenGaussDebugBacktraceFrame, OpenGaussDebugBreakpoint, OpenGaussDebugCodeLine, OpenGaussDebugLocal, OpenGaussDebugPosition } from "@/lib/backend/tauri";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
  kind: string;
  routineName: string;
  signature?: string;
  callSql: string;
}>();

type DebugPhase = "starting" | "running" | "finished" | "error";

const phase = ref<DebugPhase>("starting");
const errorMessage = ref("");
const sessionId = ref("");
const position = ref<OpenGaussDebugPosition | null>(null);
const code = ref<OpenGaussDebugCodeLine[]>([]);
const locals = ref<OpenGaussDebugLocal[]>([]);
const backtrace = ref<OpenGaussDebugBacktraceFrame[]>([]);
const breakpoints = ref<OpenGaussDebugBreakpoint[]>([]);
const busy = ref(false);
const callResult = ref<string | null>(null);
const editingLocal = ref<string | null>(null);
const editingLocalValue = ref("");

const targetLabel = computed(() => `${props.schema ? `${props.schema}.` : ""}${props.routineName}`);
const currentLineno = computed(() => position.value?.lineno ?? null);
const isBusy = computed(() => busy.value || phase.value === "starting");
const breakpointLines = computed(() => new Map(breakpoints.value.map((bp) => [bp.lineno, bp])));

watch(
  () => [open.value, props.connectionId, props.database, props.routineName, props.callSql] as const,
  ([isOpen]) => {
    if (isOpen) void startSession();
    else void stopSession(false);
  },
  { immediate: true },
);

async function startSession() {
  phase.value = "starting";
  errorMessage.value = "";
  callResult.value = null;
  position.value = null;
  locals.value = [];
  backtrace.value = [];
  breakpoints.value = [];
  sessionId.value = "";
  try {
    const started = await api.opengaussDebugStart({
      connectionId: props.connectionId,
      database: props.database,
      schema: props.schema ?? "",
      kind: props.kind,
      name: props.routineName,
      signature: props.signature,
      callSql: props.callSql,
    });
    sessionId.value = started.sessionId;
    position.value = started.position;
    code.value = started.code;
    breakpoints.value = started.breakpoints;
    phase.value = started.position.finished ? "finished" : "running";
    await refreshState();
  } catch (error: any) {
    phase.value = "error";
    errorMessage.value = error?.message || String(error);
  }
}

async function refreshState() {
  if (!sessionId.value) return;
  const [nextLocals, nextBacktrace, nextBreakpoints] = await Promise.all([
    api.opengaussDebugLocals(sessionId.value).catch(() => [] as OpenGaussDebugLocal[]),
    api.opengaussDebugBacktrace(sessionId.value).catch(() => [] as OpenGaussDebugBacktraceFrame[]),
    api.opengaussDebugBreakpoints(sessionId.value).catch(() => [] as OpenGaussDebugBreakpoint[]),
  ]);
  locals.value = nextLocals;
  backtrace.value = nextBacktrace;
  breakpoints.value = nextBreakpoints;
}

async function step(action: "next" | "step" | "finish" | "continue") {
  if (!sessionId.value || busy.value || phase.value !== "running") return;
  busy.value = true;
  errorMessage.value = "";
  try {
    const next = await api.opengaussDebugStep(sessionId.value, action);
    position.value = next;
    if (next.finished) {
      phase.value = "finished";
      await fetchCallResult();
    }
    await refreshState();
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  } finally {
    busy.value = false;
  }
}

async function fetchCallResult() {
  if (!sessionId.value) return;
  try {
    callResult.value = await api.opengaussDebugCallResult(sessionId.value);
  } catch (error: any) {
    callResult.value = error?.message || String(error);
  }
}

async function toggleBreakpoint(line: OpenGaussDebugCodeLine) {
  if (!sessionId.value || !line.canbreak || line.lineno == null) return;
  const existing = breakpointLines.value.get(line.lineno);
  try {
    if (existing) {
      breakpoints.value = await api.opengaussDebugDeleteBreakpoint(sessionId.value, existing.breakpointno);
    } else {
      breakpoints.value = await api.opengaussDebugAddBreakpoint(sessionId.value, line.lineno);
    }
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  }
}

async function setBreakpointEnabled(bp: OpenGaussDebugBreakpoint, enable: boolean) {
  if (!sessionId.value) return;
  try {
    breakpoints.value = await api.opengaussDebugToggleBreakpoint(sessionId.value, bp.breakpointno, enable);
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  }
}

async function removeBreakpoint(bp: OpenGaussDebugBreakpoint) {
  if (!sessionId.value) return;
  try {
    breakpoints.value = await api.opengaussDebugDeleteBreakpoint(sessionId.value, bp.breakpointno);
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  }
}

function beginEditLocal(local: OpenGaussDebugLocal) {
  if (local.isconst || phase.value !== "running") return;
  editingLocal.value = local.varname;
  editingLocalValue.value = local.value ?? "";
}

async function commitEditLocal(local: OpenGaussDebugLocal) {
  if (editingLocal.value !== local.varname) return;
  try {
    const ok = await api.opengaussDebugSetVar(sessionId.value, local.varname, editingLocalValue.value);
    if (!ok) errorMessage.value = t("plDebug.setVarFailed", { name: local.varname });
    locals.value = await api.opengaussDebugLocals(sessionId.value).catch(() => locals.value);
  } catch (error: any) {
    errorMessage.value = error?.message || String(error);
  } finally {
    editingLocal.value = null;
  }
}

async function stopSession(closeDialog: boolean) {
  const id = sessionId.value;
  sessionId.value = "";
  if (id) await api.opengaussDebugStop(id).catch(() => undefined);
  if (closeDialog) open.value = false;
}

const handleOpenChange = (next: boolean) => {
  if (!next) void stopSession(true);
  open.value = next;
};
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="flex max-h-[90vh] flex-col border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[1080px]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-base">
          <Bug class="h-4 w-4 text-primary" />
          <span class="truncate">{{ t("plDebug.title", { name: targetLabel }) }}</span>
          <Badge v-if="phase === 'running'" variant="outline" class="border-emerald-500/40 text-emerald-600">{{ t("plDebug.running") }}</Badge>
          <Badge v-else-if="phase === 'finished'" variant="outline">{{ t("plDebug.finished") }}</Badge>
          <Badge v-else-if="phase === 'error'" variant="destructive">{{ t("plDebug.error") }}</Badge>
        </DialogTitle>
      </DialogHeader>

      <div v-if="phase === 'starting'" class="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" />
        {{ t("plDebug.starting") }}
      </div>

      <template v-else>
        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-1.5 border-y py-2">
          <Button size="sm" variant="outline" :disabled="isBusy || phase !== 'running'" @click="step('continue')"> <CirclePlay class="h-3.5 w-3.5" /> {{ t("plDebug.continue") }} </Button>
          <Button size="sm" variant="outline" :disabled="isBusy || phase !== 'running'" @click="step('next')"> <StepForward class="h-3.5 w-3.5" /> {{ t("plDebug.next") }} </Button>
          <Button size="sm" variant="outline" :disabled="isBusy || phase !== 'running'" @click="step('step')"> <StepForward class="h-3.5 w-3.5 rotate-90" /> {{ t("plDebug.step") }} </Button>
          <Button size="sm" variant="outline" :disabled="isBusy || phase !== 'running'" @click="step('finish')"> <StepForward class="h-3.5 w-3.5 -rotate-90" /> {{ t("plDebug.finish") }} </Button>
          <Button size="sm" variant="outline" :disabled="isBusy" @click="refreshState"> <RefreshCw class="h-3.5 w-3.5" /> {{ t("plDebug.refresh") }} </Button>
          <div class="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="destructive" :disabled="!sessionId" @click="stopSession(true)"> <OctagonX class="h-3.5 w-3.5" /> {{ t("plDebug.stop") }} </Button>
          <span v-if="busy" class="ml-1 flex items-center gap-1 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" /></span>
          <span v-if="currentLineno != null && phase === 'running'" class="ml-auto font-mono text-xs text-muted-foreground">
            {{ t("plDebug.currentLine", { line: currentLineno }) }}
          </span>
        </div>

        <div v-if="errorMessage" class="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          {{ errorMessage }}
        </div>
        <div v-if="phase === 'finished' && callResult" class="rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
          {{ callResult }}
        </div>

        <div class="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,1fr)]">
          <!-- Code pane -->
          <div class="min-h-0 overflow-auto rounded-md border bg-muted/20 font-mono text-xs">
            <div v-for="(line, index) in code" :key="index" class="flex items-stretch gap-0 border-b border-border/40 last:border-b-0" :class="{ 'bg-primary/15': line.lineno != null && line.lineno === currentLineno }">
              <button type="button" class="flex w-8 shrink-0 items-center justify-center" :class="line.canbreak ? 'cursor-pointer' : 'cursor-default'" @click="toggleBreakpoint(line)">
                <span v-if="breakpointLines.get(line.lineno ?? -1)?.enable" class="h-2.5 w-2.5 rounded-full bg-destructive" />
                <span v-else-if="breakpointLines.get(line.lineno ?? -1)" class="h-2.5 w-2.5 rounded-full border border-destructive/60 bg-destructive/30" />
                <span v-else-if="line.canbreak" class="h-2.5 w-2.5 rounded-full border border-muted-foreground/30 hover:border-destructive/60" />
              </button>
              <div class="w-10 shrink-0 border-r border-border/40 px-1 py-1.5 text-right text-muted-foreground/70 select-none">
                {{ line.lineno ?? "" }}
              </div>
              <div class="min-w-0 flex-1 truncate px-2 py-1.5" :class="{ 'text-muted-foreground': line.canbreak === false }" :title="line.query"><span v-if="line.lineno != null && line.lineno === currentLineno" class="mr-1 text-primary">▶</span>{{ line.query }}</div>
            </div>
          </div>

          <!-- Right column -->
          <div class="flex min-h-0 flex-col gap-3 overflow-hidden">
            <div class="min-h-0 flex-1 overflow-auto rounded-md border">
              <div class="border-b bg-muted/50 px-2.5 py-1.5 text-xs font-medium">{{ t("plDebug.locals") }}</div>
              <div v-if="!locals.length" class="px-2.5 py-2 text-xs text-muted-foreground">{{ t("plDebug.noLocals") }}</div>
              <div v-for="local in locals" :key="local.varname" class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b px-2.5 py-1.5 text-xs last:border-b-0">
                <div class="min-w-0">
                  <span class="font-medium">{{ local.varname }}</span>
                  <span class="ml-1.5 text-muted-foreground">{{ local.vartype }}</span>
                  <span v-if="local.packageName" class="ml-1.5 text-muted-foreground">· {{ local.packageName }}</span>
                </div>
                <div class="text-right font-mono">
                  <input
                    v-if="editingLocal === local.varname"
                    v-model="editingLocalValue"
                    class="h-6 w-32 rounded border border-input bg-background px-1 font-mono text-xs"
                    autofocus
                    @keydown.enter.prevent="commitEditLocal(local)"
                    @keydown.esc.prevent="editingLocal = null"
                    @blur="commitEditLocal(local)"
                  />
                  <button v-else type="button" class="hover:text-primary" :title="local.isconst ? t('plDebug.constVar') : t('plDebug.editVar')" @dblclick="beginEditLocal(local)" @click="beginEditLocal(local)">
                    {{ local.value ?? "NULL" }}
                  </button>
                </div>
              </div>
            </div>

            <div class="max-h-40 overflow-auto rounded-md border">
              <div class="border-b bg-muted/50 px-2.5 py-1.5 text-xs font-medium">{{ t("plDebug.backtrace") }}</div>
              <div v-if="!backtrace.length" class="px-2.5 py-2 text-xs text-muted-foreground">—</div>
              <div v-for="frame in backtrace" :key="frame.frameno" class="flex gap-2 border-b px-2.5 py-1 text-xs last:border-b-0">
                <span class="text-muted-foreground">#{{ frame.frameno }}</span>
                <span class="font-medium">{{ frame.funcname }}</span>
                <span v-if="frame.lineno != null" class="text-muted-foreground">:{{ frame.lineno }}</span>
                <span class="min-w-0 truncate text-muted-foreground" :title="frame.query">{{ frame.query }}</span>
              </div>
            </div>

            <div class="max-h-36 overflow-auto rounded-md border">
              <div class="border-b bg-muted/50 px-2.5 py-1.5 text-xs font-medium">{{ t("plDebug.breakpoints") }}</div>
              <div v-if="!breakpoints.length" class="px-2.5 py-2 text-xs text-muted-foreground">{{ t("plDebug.noBreakpoints") }}</div>
              <div v-for="bp in breakpoints" :key="bp.breakpointno" class="flex items-center gap-2 border-b px-2.5 py-1 text-xs last:border-b-0">
                <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="bp.enable" @change="(event: Event) => setBreakpointEnabled(bp, (event.target as HTMLInputElement).checked)" />
                <span class="text-muted-foreground">L{{ bp.lineno }}</span>
                <span class="min-w-0 flex-1 truncate" :title="bp.query">{{ bp.query }}</span>
                <button type="button" class="text-muted-foreground hover:text-destructive" @click="removeBreakpoint(bp)">✕</button>
              </div>
            </div>
          </div>
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>
