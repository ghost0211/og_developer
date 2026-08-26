<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { FolderGit2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });

defineProps<{
  appVersion: string;
}>();
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="border border-border !bg-background text-foreground shadow-2xl !backdrop-blur-none sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>{{ t("about.title") }}</DialogTitle>
      </DialogHeader>
      <div class="flex flex-col items-center gap-4 py-4 text-center">
        <img src="/logo.png" alt="OG Developer" class="h-20 w-20" />
        <div class="space-y-1">
          <div class="text-lg font-semibold">OG Developer</div>
          <div v-if="appVersion" class="font-mono text-sm text-muted-foreground">v{{ appVersion }}</div>
        </div>
        <p class="max-w-sm text-sm leading-6 text-muted-foreground">
          {{ t("about.description") }}
        </p>
        <a href="https://github.com/ghost0211/og_developer" class="inline-flex items-center gap-1.5 text-sm text-primary hover:underline" target="_blank" rel="noopener noreferrer">
          <FolderGit2 class="h-4 w-4" />
          {{ t("about.repository") }}
        </a>
      </div>
    </DialogContent>
  </Dialog>
</template>
