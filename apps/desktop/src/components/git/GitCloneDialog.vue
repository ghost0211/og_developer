<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, GitBranch, Loader2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useProjectStore } from "@/stores/projectStore";
import { useGitStore } from "@/stores/gitStore";
import { formatGitErrorMessage } from "@/lib/git/gitUtils";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  cloned: [path: string];
}>();

const { t } = useI18n();
const { toast } = useToast();
const projectStore = useProjectStore();
const gitStore = useGitStore();

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => {
    if (loading.value && !value) return;
    emit("update:open", value);
  },
});

const url = ref("");
const targetDir = ref("");
const username = ref("");
const token = ref("");
const branch = ref("");
const loading = ref(false);
const errorMsg = ref("");

function extractRepoName(repoUrl: string): string {
  const clean = repoUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const parts = clean.split(/[/:\\]/);
  return parts[parts.length - 1] || "git-project";
}

async function pickTargetDirectory() {
  if (!isTauriRuntime()) return;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      targetDir.value = selected;
    }
  } catch (e: unknown) {
    toast(formatGitErrorMessage(e, t), 4000);
  }
}

function resetForm() {
  url.value = "";
  targetDir.value = "";
  username.value = "";
  token.value = "";
  branch.value = "";
  loading.value = false;
  errorMsg.value = "";
}

watch(
  () => props.open,
  (val) => {
    if (!val) {
      // Clear sensitive token when dialog closes
      token.value = "";
      errorMsg.value = "";
    }
  },
);

async function handleClone() {
  const trimmedUrl = url.value.trim();
  const trimmedDir = targetDir.value.trim();

  if (!trimmedUrl) {
    errorMsg.value = t("git.urlRequired");
    return;
  }
  if (!trimmedDir) {
    errorMsg.value = t("git.targetDirRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";

  try {
    const clonedPath = await gitStore.clone({
      url: trimmedUrl,
      targetDir: trimmedDir,
      username: username.value.trim() || undefined,
      token: token.value || undefined,
      branch: branch.value.trim() || undefined,
    });

    const repoName = extractRepoName(trimmedUrl);
    projectStore.addProject(repoName, clonedPath);
    await gitStore.refresh();

    toast(t("git.cloneSuccess"), 2500);
    emit("cloned", clonedPath);
    emit("update:open", false);
    resetForm();
  } catch (e: unknown) {
    errorMsg.value = formatGitErrorMessage(e, t);
    toast(errorMsg.value, 5000);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <GitBranch class="h-5 w-5 text-primary" />
          <span>{{ t("git.cloneTitle") }}</span>
        </DialogTitle>
      </DialogHeader>

      <form class="space-y-4 py-2" @submit.prevent="handleClone">
        <!-- Repo URL -->
        <div class="space-y-1.5">
          <Label for="git-clone-url">{{ t("git.url") }} <span class="text-destructive">*</span></Label>
          <Input id="git-clone-url" v-model="url" :placeholder="t('git.urlPlaceholder')" :disabled="loading" autocomplete="off" autofocus />
        </div>

        <!-- Target Directory -->
        <div class="space-y-1.5">
          <Label for="git-clone-dir">{{ t("git.targetDir") }} <span class="text-destructive">*</span></Label>
          <div class="flex gap-2">
            <Input id="git-clone-dir" v-model="targetDir" :placeholder="t('git.targetDirPlaceholder')" :disabled="loading" class="flex-1" />
            <Button type="button" variant="outline" :disabled="loading" @click="pickTargetDirectory">
              <FolderOpen class="h-4 w-4 mr-1.5" />
              <span>{{ t("git.browse") }}</span>
            </Button>
          </div>
        </div>

        <!-- Optional Branch -->
        <div class="space-y-1.5">
          <Label for="git-clone-branch">{{ t("git.branch") }}</Label>
          <Input id="git-clone-branch" v-model="branch" :placeholder="t('git.branchPlaceholder')" :disabled="loading" autocomplete="off" />
        </div>

        <!-- Credentials section (optional) -->
        <div class="grid grid-cols-2 gap-3 pt-1">
          <div class="space-y-1.5">
            <Label for="git-clone-user">{{ t("git.username") }}</Label>
            <Input id="git-clone-user" v-model="username" :placeholder="t('git.usernamePlaceholder')" :disabled="loading" autocomplete="off" />
          </div>
          <div class="space-y-1.5">
            <Label for="git-clone-token">{{ t("git.token") }}</Label>
            <PasswordInput id="git-clone-token" v-model="token" :placeholder="t('git.tokenPlaceholder')" :disabled="loading" />
          </div>
        </div>

        <div v-if="errorMsg" class="text-xs text-destructive bg-destructive/10 p-2.5 rounded-md break-all">
          {{ errorMsg }}
        </div>

        <DialogFooter class="pt-2">
          <Button type="button" variant="outline" :disabled="loading" @click="dialogOpen = false">
            {{ t("common.cancel") }}
          </Button>
          <Button type="submit" :disabled="loading || !url.trim() || !targetDir.trim()">
            <Loader2 v-if="loading" class="h-4 w-4 mr-2 animate-spin" />
            <span>{{ loading ? t("git.cloning") : t("git.clone") }}</span>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
