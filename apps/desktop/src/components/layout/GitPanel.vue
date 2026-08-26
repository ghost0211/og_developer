<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, FolderGit2, FolderOpen, GitBranch, Loader2, Minus, Plus, RefreshCw, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/composables/useToast";
import { useGitStore } from "@/stores/gitStore";
import { useProjectStore } from "@/stores/projectStore";
import { formatGitErrorMessage, getGitStatusBadge } from "@/lib/git/gitUtils";
import type { GitChangeStatus, GitStatusEntry } from "@/types/git";

const emit = defineEmits<{
  close: [];
  "create-project": [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const gitStore = useGitStore();
const projectStore = useProjectStore();

const commitMessage = ref("");
const newBranchInput = ref("");
const showBranchMenu = ref(false);

const activeProject = computed(() => projectStore.activeProject.value);

onMounted(() => {
  void gitStore.refresh();
});

async function handleRefresh() {
  await gitStore.refresh();
  toast(t("git.refreshed"), 1500);
}

async function handlePull() {
  if (gitStore.mutating) return;
  try {
    const summary = await gitStore.pull();
    toast(summary ? `${t("git.pullSuccess")}: ${summary}` : t("git.pullSuccess"), 3000);
  } catch (e: unknown) {
    toast(formatGitErrorMessage(e, t), 5000);
  }
}

async function handlePush() {
  if (gitStore.mutating) return;
  try {
    const summary = await gitStore.push();
    toast(summary ? `${t("git.pushSuccess")}: ${summary}` : t("git.pushSuccess"), 3000);
  } catch (e: unknown) {
    toast(formatGitErrorMessage(e, t), 5000);
  }
}

async function handleCheckout(branch: string) {
  if (gitStore.mutating || branch === gitStore.currentBranch) return;
  try {
    await gitStore.checkout(branch);
    toast(t("git.checkoutSuccess", { branch }), 2500);
    showBranchMenu.value = false;
  } catch (e: unknown) {
    toast(formatGitErrorMessage(e, t), 5000);
  }
}

async function handleCreateBranch() {
  const name = newBranchInput.value.trim();
  if (!name || gitStore.mutating) return;
  try {
    await gitStore.createBranch(name);
    newBranchInput.value = "";
    showBranchMenu.value = false;
    toast(t("git.checkoutSuccess", { branch: name }), 2500);
  } catch (e: unknown) {
    toast(formatGitErrorMessage(e, t), 5000);
  }
}

async function handleStage(entry: GitStatusEntry, e?: Event) {
  e?.stopPropagation();
  try {
    await gitStore.stage([entry.path]);
  } catch (err: unknown) {
    toast(formatGitErrorMessage(err, t), 4000);
  }
}

async function handleUnstage(entry: GitStatusEntry, e?: Event) {
  e?.stopPropagation();
  try {
    await gitStore.unstage([entry.path]);
  } catch (err: unknown) {
    toast(formatGitErrorMessage(err, t), 4000);
  }
}

async function handleStageAll() {
  try {
    await gitStore.stageAll();
  } catch (err: unknown) {
    toast(formatGitErrorMessage(err, t), 4000);
  }
}

async function handleUnstageAll() {
  try {
    await gitStore.unstageAll();
  } catch (err: unknown) {
    toast(formatGitErrorMessage(err, t), 4000);
  }
}

function handleOpenFileDiff(entry: GitStatusEntry) {
  void gitStore.openDiff(entry.path, entry.staged);
}

async function handleCommit() {
  const msg = commitMessage.value.trim();
  if (!msg) {
    toast(t("git.commitMessageRequired"), 2500);
    return;
  }
  if (gitStore.stagedEntries.length === 0) {
    toast(t("git.noStagedToCommit"), 2500);
    return;
  }
  try {
    await gitStore.commit(msg);
    commitMessage.value = "";
    toast(t("git.commitSuccess"), 2000);
  } catch (err: unknown) {
    toast(formatGitErrorMessage(err, t), 5000);
  }
}

function getFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function getFileDir(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function statusBadge(status: GitChangeStatus) {
  return getGitStatusBadge(status);
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden bg-background select-none text-xs">
    <!-- Panel Header -->
    <div class="h-9 flex items-center gap-1 px-2.5 border-b shrink-0 bg-muted/20">
      <span class="text-[13px] font-semibold text-foreground truncate">{{ t("git.title") }}</span>
      <span class="flex-1" />

      <!-- Pull Button -->
      <LightTooltip v-if="gitStore.isRepo" :text="t('git.pull')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-6 w-6 relative" :disabled="gitStore.mutating || gitStore.loading" @click="handlePull">
          <ArrowDownToLine class="h-3.5 w-3.5" />
          <span v-if="gitStore.behind > 0" class="absolute -top-0.5 -right-0.5 text-[9px] font-bold text-amber-500 bg-background rounded-full px-0.5 shadow-sm leading-none">
            {{ gitStore.behind }}
          </span>
        </Button>
      </LightTooltip>

      <!-- Push Button -->
      <LightTooltip v-if="gitStore.isRepo" :text="t('git.push')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-6 w-6 relative" :disabled="gitStore.mutating || gitStore.loading" @click="handlePush">
          <ArrowUpFromLine class="h-3.5 w-3.5" />
          <span v-if="gitStore.ahead > 0" class="absolute -top-0.5 -right-0.5 text-[9px] font-bold text-emerald-500 bg-background rounded-full px-0.5 shadow-sm leading-none">
            {{ gitStore.ahead }}
          </span>
        </Button>
      </LightTooltip>

      <!-- Refresh Button -->
      <LightTooltip v-if="activeProject" :text="t('git.refresh')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="gitStore.mutating || gitStore.loading" @click="handleRefresh">
          <RefreshCw class="h-3.5 w-3.5" :class="gitStore.loading || gitStore.mutating ? 'animate-spin' : ''" />
        </Button>
      </LightTooltip>

      <!-- Close Button -->
      <LightTooltip :text="t('common.close')" side="bottom" :delay="0" :close-delay="0" nowrap>
        <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('close')">
          <X class="h-3.5 w-3.5" />
        </Button>
      </LightTooltip>
    </div>

    <!-- Empty State: No Active Project -->
    <div v-if="!activeProject" class="h-full flex flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground">
      <FolderOpen class="h-8 w-8 text-muted-foreground/40" />
      <span class="text-xs">{{ t("git.noProject") }}</span>
      <Button variant="outline" size="sm" class="h-7 text-xs" @click="emit('create-project')">
        <Plus class="h-3.5 w-3.5 mr-1" />
        {{ t("menus.createProject") }}
      </Button>
    </div>

    <!-- Empty State: Project is not a Git Repo -->
    <div v-else-if="!gitStore.isRepo && !gitStore.loading" class="h-full flex flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground">
      <FolderGit2 class="h-8 w-8 text-muted-foreground/40" />
      <span class="text-xs">{{ t("git.notRepo") }}</span>
      <Button variant="outline" size="sm" class="h-7 text-xs" @click="gitStore.openCloneDialog">
        <GitBranch class="h-3.5 w-3.5 mr-1" />
        {{ t("git.openClone") }}
      </Button>
    </div>

    <!-- Main Git Panel Body -->
    <div v-else class="flex-1 flex flex-col min-h-0">
      <!-- Branch Selector & Sync Summary -->
      <div class="px-2.5 py-1.5 border-b shrink-0 flex items-center justify-between gap-1 bg-muted/10">
        <DropdownMenu v-model:open="showBranchMenu">
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm" class="h-7 max-w-[180px] justify-between text-xs font-normal truncate px-2" :title="gitStore.currentBranch">
              <div class="flex items-center gap-1.5 truncate">
                <GitBranch class="h-3.5 w-3.5 text-primary shrink-0" />
                <span class="truncate">{{ gitStore.currentBranch || "-" }}</span>
              </div>
              <ChevronDown class="h-3 w-3 opacity-60 ml-1 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-64 max-h-80 overflow-y-auto">
            <!-- Create new branch input -->
            <div class="p-1.5 border-b" @click.stop @keydown.stop>
              <form class="flex gap-1" @submit.prevent="handleCreateBranch">
                <Input v-model="newBranchInput" :placeholder="t('git.newBranchPlaceholder')" class="h-7 text-xs" autofocus />
                <Button type="submit" size="sm" class="h-7 px-2 text-xs" :disabled="!newBranchInput.trim()">
                  {{ t("git.createBranch") }}
                </Button>
              </form>
            </div>

            <!-- Local branches -->
            <template v-if="gitStore.branches?.local?.length">
              <DropdownMenuLabel class="px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                {{ t("git.localBranches") }}
              </DropdownMenuLabel>
              <DropdownMenuItem v-for="b in gitStore.branches.local" :key="b" class="text-xs cursor-pointer flex items-center justify-between" @select="handleCheckout(b)">
                <span class="truncate">{{ b }}</span>
                <Check v-if="b === gitStore.currentBranch" class="h-3.5 w-3.5 text-primary ml-2 shrink-0" />
              </DropdownMenuItem>
            </template>

            <!-- Remote branches -->
            <template v-if="gitStore.branches?.remote?.length">
              <DropdownMenuSeparator />
              <DropdownMenuLabel class="px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wider">
                {{ t("git.remoteBranches") }}
              </DropdownMenuLabel>
              <DropdownMenuItem v-for="rb in gitStore.branches.remote" :key="rb" class="text-xs cursor-pointer flex items-center justify-between text-muted-foreground hover:text-foreground" @select="handleCheckout(rb)">
                <span class="truncate">{{ rb }}</span>
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>

        <!-- Ahead / Behind stats -->
        <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0">
          <span v-if="gitStore.behind > 0" class="text-amber-500 font-medium" :title="t('git.pull')"> ↓{{ gitStore.behind }} </span>
          <span v-if="gitStore.ahead > 0" class="text-emerald-500 font-medium" :title="t('git.push')"> ↑{{ gitStore.ahead }} </span>
        </div>
      </div>

      <!-- File Changes Lists (Scrollable) -->
      <div class="flex-1 min-h-0 overflow-y-auto divide-y divide-border/40">
        <!-- 1. Staged Changes Section -->
        <div v-if="gitStore.stagedEntries.length > 0" class="py-1">
          <div class="group flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-muted-foreground tracking-wide">
            <div class="flex items-center gap-1.5">
              <span>{{ t("git.stagedChanges") }}</span>
              <Badge variant="secondary" class="h-4 px-1.5 text-[10px] font-mono leading-none">
                {{ gitStore.stagedEntries.length }}
              </Badge>
            </div>
            <LightTooltip :text="t('git.unstageAll')" side="left" :delay="100" nowrap>
              <Button variant="ghost" size="icon" class="h-5 w-5 opacity-70 hover:opacity-100" :disabled="gitStore.mutating" @click="handleUnstageAll">
                <Minus class="h-3 w-3" />
              </Button>
            </LightTooltip>
          </div>

          <!-- Staged file entries -->
          <div v-for="entry in gitStore.stagedEntries" :key="'staged-' + entry.path" class="group/item flex items-center gap-2 px-2.5 py-1 hover:bg-muted/60 cursor-pointer transition-colors" :title="entry.path" @click="handleOpenFileDiff(entry)">
            <span class="inline-flex items-center justify-center h-4 w-4 rounded text-[10px] font-mono font-bold shrink-0 border" :class="statusBadge(entry.status).bgClass" :title="t(statusBadge(entry.status).labelKey)">
              {{ statusBadge(entry.status).letter }}
            </span>
            <div class="min-w-0 flex-1 flex items-baseline gap-1 truncate">
              <span class="font-medium text-foreground truncate">{{ getFileName(entry.path) }}</span>
              <span v-if="getFileDir(entry.path)" class="text-[10px] text-muted-foreground/70 truncate">{{ getFileDir(entry.path) }}</span>
            </div>
            <LightTooltip :text="t('git.unstage')" side="left" :delay="100" nowrap>
              <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0" :disabled="gitStore.mutating" @click="handleUnstage(entry, $event)">
                <Minus class="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </Button>
            </LightTooltip>
          </div>
        </div>

        <!-- 2. Unstaged Changes Section -->
        <div v-if="gitStore.unstagedEntries.length > 0" class="py-1">
          <div class="group flex items-center justify-between px-2.5 py-1 text-[11px] font-semibold text-muted-foreground tracking-wide">
            <div class="flex items-center gap-1.5">
              <span>{{ t("git.changes") }}</span>
              <Badge variant="secondary" class="h-4 px-1.5 text-[10px] font-mono leading-none">
                {{ gitStore.unstagedEntries.length }}
              </Badge>
            </div>
            <LightTooltip :text="t('git.stageAll')" side="left" :delay="100" nowrap>
              <Button variant="ghost" size="icon" class="h-5 w-5 opacity-70 hover:opacity-100" :disabled="gitStore.mutating" @click="handleStageAll">
                <Plus class="h-3 w-3" />
              </Button>
            </LightTooltip>
          </div>

          <!-- Unstaged file entries -->
          <div v-for="entry in gitStore.unstagedEntries" :key="'unstaged-' + entry.path" class="group/item flex items-center gap-2 px-2.5 py-1 hover:bg-muted/60 cursor-pointer transition-colors" :title="entry.path" @click="handleOpenFileDiff(entry)">
            <span class="inline-flex items-center justify-center h-4 w-4 rounded text-[10px] font-mono font-bold shrink-0 border" :class="statusBadge(entry.status).bgClass" :title="t(statusBadge(entry.status).labelKey)">
              {{ statusBadge(entry.status).letter }}
            </span>
            <div class="min-w-0 flex-1 flex items-baseline gap-1 truncate">
              <span class="font-medium text-foreground truncate">{{ getFileName(entry.path) }}</span>
              <span v-if="getFileDir(entry.path)" class="text-[10px] text-muted-foreground/70 truncate">{{ getFileDir(entry.path) }}</span>
            </div>
            <LightTooltip :text="t('git.stage')" side="left" :delay="100" nowrap>
              <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover/item:opacity-100 transition-opacity shrink-0" :disabled="gitStore.mutating" @click="handleStage(entry, $event)">
                <Plus class="h-3 w-3 text-muted-foreground hover:text-foreground" />
              </Button>
            </LightTooltip>
          </div>
        </div>

        <!-- Clean Tree Indicator -->
        <div v-if="gitStore.entries.length === 0 && !gitStore.loading" class="flex flex-col items-center justify-center p-8 text-center text-muted-foreground gap-2">
          <Check class="h-6 w-6 text-emerald-500/70" />
          <span>{{ t("git.noChanges") }}</span>
        </div>
      </div>

      <!-- Commit Section (Bottom Fixed) -->
      <div class="p-2.5 border-t shrink-0 bg-muted/20 space-y-2">
        <textarea
          v-model="commitMessage"
          :placeholder="t('git.commitMessagePlaceholder')"
          rows="3"
          class="w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          :disabled="gitStore.mutating"
          @keydown.ctrl.enter="handleCommit"
          @keydown.meta.enter="handleCommit"
        />
        <Button class="w-full h-7 text-xs font-medium" :disabled="gitStore.mutating || !commitMessage.trim() || gitStore.stagedEntries.length === 0" @click="handleCommit">
          <Loader2 v-if="gitStore.mutating" class="h-3.5 w-3.5 mr-1.5 animate-spin" />
          <span>{{ t("git.commit") }}</span>
        </Button>
      </div>
    </div>
  </div>
</template>
