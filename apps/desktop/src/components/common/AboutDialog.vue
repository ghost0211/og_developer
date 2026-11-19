<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { FolderGit2, RefreshCw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ReleaseNotesPanel from "@/components/common/ReleaseNotesPanel.vue";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  "check-updates": [];
}>();

defineProps<{
  appVersion: string;
}>();
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[540px]">
      <DialogHeader>
        <DialogTitle>{{ t("about.title") }}</DialogTitle>
      </DialogHeader>
      <div class="flex flex-col items-center gap-3.5 py-2 text-center">
        <img src="/logo.png" alt="OG Developer" class="h-16 w-16" />
        <div class="space-y-1">
          <div class="text-lg font-semibold">OG Developer</div>
          <div v-if="appVersion" class="font-mono text-sm text-muted-foreground">v{{ appVersion }}</div>
        </div>
        <p class="max-w-sm text-sm leading-6 text-muted-foreground">
          {{ t("about.description") }}
        </p>
        <div class="flex flex-wrap items-center justify-center gap-3">
          <a href="https://github.com/ghost0211/og_developer" class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline" target="_blank" rel="noopener noreferrer">
            <FolderGit2 class="h-4 w-4" />
            {{ t("about.repository") }}
          </a>
          <Button variant="outline" size="sm" @click="emit('check-updates')">
            <RefreshCw class="h-3.5 w-3.5" />
            {{ t("updates.check") }}
          </Button>
        </div>
        <ReleaseNotesPanel compact :current-version="appVersion" class="w-full text-left" />
      </div>
    </DialogContent>
  </Dialog>
</template>
