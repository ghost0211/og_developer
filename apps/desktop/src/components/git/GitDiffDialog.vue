<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { FileCode, Loader2, X } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useGitStore } from "@/stores/gitStore";
import { buildGitInlineDiff, type GitDiffRow, type GitDiffSegment } from "@/lib/git/gitUtils";

const gitStore = useGitStore();
const { t } = useI18n();

const dialogOpen = computed({
  get: () => gitStore.diffModalOpen,
  set: (value) => {
    if (!value) gitStore.closeDiff();
  },
});

const diffData = computed(() => gitStore.diffData);

const rows = computed<GitDiffRow[]>(() => {
  if (!diffData.value) return [];
  return buildGitInlineDiff(diffData.value.oldText || "", diffData.value.newText || "", diffData.value.isNew, diffData.value.isDeleted);
});

function lineClass(type: GitDiffRow["type"]) {
  switch (type) {
    case "delete":
      return "bg-red-500/15 text-red-100";
    case "insert":
      return "bg-emerald-500/15 text-emerald-100";
    case "equal":
    default:
      return "text-zinc-300";
  }
}

function gutterClass(type: GitDiffRow["type"]) {
  switch (type) {
    case "delete":
      return "text-red-400 select-none bg-red-950/20";
    case "insert":
      return "text-emerald-400 select-none bg-emerald-950/20";
    case "equal":
    default:
      return "text-zinc-600 select-none";
  }
}

function segmentClass(type: GitDiffRow["type"], segment: GitDiffSegment) {
  if (!segment.changed) return "";
  if (type === "delete") {
    return "bg-red-500/70 text-red-50 rounded-[2px] px-0.5";
  }
  if (type === "insert") {
    return "bg-emerald-500/70 text-emerald-50 rounded-[2px] px-0.5";
  }
  return "";
}

function linePrefix(type: GitDiffRow["type"]): string {
  if (type === "delete") return "-";
  if (type === "insert") return "+";
  return " ";
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent :show-close-button="false" class="git-diff-dialog flex h-[min(90vh,920px)] w-[min(94vw,1100px)] max-w-[min(94vw,1100px)] flex-col gap-0 overflow-hidden rounded-lg p-0 shadow-2xl">
      <DialogHeader class="shrink-0 border-b px-5 py-3 bg-muted/40">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-2.5 min-w-0">
            <FileCode class="h-4 w-4 text-primary shrink-0" />
            <DialogTitle class="text-sm font-semibold truncate">
              {{ gitStore.diffFile?.path || t("git.diffTitle") }}
            </DialogTitle>
            <Badge v-if="gitStore.diffFile" variant="outline" class="text-[11px] font-normal shrink-0" :class="gitStore.diffFile.staged ? 'border-primary/40 text-primary' : 'text-muted-foreground'">
              {{ gitStore.diffFile.staged ? t("git.staged") : t("git.unstaged") }}
            </Badge>
            <Badge v-if="diffData?.isNew" variant="outline" class="text-[11px] text-emerald-500 border-emerald-500/30 shrink-0">
              {{ t("git.statusAdded") }}
            </Badge>
            <Badge v-else-if="diffData?.isDeleted" variant="outline" class="text-[11px] text-red-500 border-red-500/30 shrink-0">
              {{ t("git.statusDeleted") }}
            </Badge>
          </div>
          <button type="button" class="rounded-sm opacity-70 hover:opacity-100 transition-opacity p-1 text-muted-foreground hover:text-foreground" :aria-label="t('common.close')" @click="gitStore.closeDiff">
            <X class="h-4 w-4" />
          </button>
        </div>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-auto bg-[#18181b] font-mono text-[13px] leading-6 select-text">
        <div v-if="gitStore.diffLoading" class="flex h-full items-center justify-center gap-2 p-10 text-muted-foreground">
          <Loader2 class="h-5 w-5 animate-spin" />
          <span>{{ t("git.diffLoading") }}</span>
        </div>

        <div v-else-if="gitStore.diffError" class="p-6 text-sm text-destructive">
          {{ gitStore.diffError }}
        </div>

        <div v-else-if="rows.length === 0" class="flex h-full items-center justify-center p-10 text-muted-foreground">
          {{ t("git.diffNoChanges") }}
        </div>

        <div v-else class="divide-y divide-zinc-800/40 min-w-max">
          <div v-for="row in rows" :key="row.id" class="grid grid-cols-[48px_48px_24px_1fr] hover:bg-zinc-800/30 transition-colors" :class="lineClass(row.type)">
            <!-- Old line number -->
            <span class="px-2 text-right text-xs border-r border-zinc-800/80" :class="gutterClass(row.type)">
              {{ row.oldLineNumber ?? "" }}
            </span>
            <!-- New line number -->
            <span class="px-2 text-right text-xs border-r border-zinc-800/80" :class="gutterClass(row.type)">
              {{ row.newLineNumber ?? "" }}
            </span>
            <!-- Prefix +/- -->
            <span class="text-center font-bold" :class="gutterClass(row.type)">
              {{ linePrefix(row.type) }}
            </span>
            <!-- Content with segment highlighting -->
            <pre class="whitespace-pre px-2 py-0 my-0 overflow-visible font-mono"><template v-for="(seg, idx) in row.segments" :key="idx"><span :class="segmentClass(row.type, seg)">{{ seg.value }}</span></template><template v-if="!row.content">&nbsp;</template></pre>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.git-diff-dialog {
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
}
</style>
