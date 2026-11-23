<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { CalendarClock, Command, FileCode, FileText, Layers, Link2, Terminal, XIcon, Zap } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useQuickOpen, type QuickOpenItem } from "@/composables/useQuickOpen";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  select: [item: QuickOpenItem];
}>();

const { t } = useI18n();
const { searchQuery, isCommandMode, filteredItems, selectedIndex, selectedItem, selectNext, selectPrevious, setQuery, loadExternalSqlFiles } = useQuickOpen();
const inputRef = ref<{ $el?: HTMLElement } | HTMLInputElement | null>(null);

function focusSearchInput() {
  nextTick(() => {
    const target = inputRef.value instanceof HTMLInputElement ? inputRef.value : (inputRef.value?.$el?.querySelector<HTMLInputElement>("input") ?? (inputRef.value as any));
    target?.focus?.();
  });
}

function enterCommandMode() {
  if (!searchQuery.value.trim().startsWith(">")) {
    setQuery("> ");
  }
  focusSearchInput();
}

const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectNext();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectPrevious();
  } else if (e.key === "Enter" && selectedItem.value) {
    e.preventDefault();
    handleSelect(selectedItem.value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    dialogOpen.value = false;
  }
}

function handleSelect(item: QuickOpenItem): void {
  emit("select", item);
  dialogOpen.value = false;
}

function getHighlightedLabel(item: any): (string | { text: string; highlight: boolean })[] {
  if (!searchQuery.value.trim() || !item.matchIndices) {
    return [item.label];
  }

  const indices = new Set(item.matchIndices);
  const parts: (string | { text: string; highlight: boolean })[] = [];
  let current = "";
  let isHighlighting = false;

  for (let i = 0; i < item.label.length; i++) {
    const char = item.label[i];
    const shouldHighlight = indices.has(i);

    if (shouldHighlight !== isHighlighting) {
      if (current) {
        parts.push({
          text: current,
          highlight: isHighlighting,
        });
      }
      current = char;
      isHighlighting = shouldHighlight;
    } else {
      current += char;
    }
  }

  if (current) {
    parts.push({
      text: current,
      highlight: isHighlighting,
    });
  }

  return parts;
}

function getTypeLabel(type: string): string {
  switch (type) {
    case "connection":
      return t("common.connection");
    case "database":
      return t("common.database");
    case "schema":
      return t("quickOpen.types.schema");
    case "table":
      return t("common.table");
    case "view":
      return t("common.view");
    case "materialized_view":
      return t("common.materializedView");
    case "procedure":
      return t("common.procedure");
    case "function":
      return t("common.function");
    case "sequence":
      return t("common.sequence");
    case "package":
      return t("common.package");
    case "package-body":
      return t("common.packageBody");
    case "synonym":
      return t("quickOpen.types.synonym");
    case "trigger":
      return t("quickOpen.types.trigger");
    case "job":
      return t("quickOpen.types.job");
    case "scheduler":
      return t("quickOpen.types.scheduler");
    case "open_tab":
      return t("quickOpen.types.openTab");
    case "command":
      return t("quickOpen.types.command");
    case "sql_file":
      return t("quickOpen.sqlFile");
    case "sql_library_file":
      return t("quickOpen.sqlLibraryFile");
    default:
      return type;
  }
}

function getItemIcon(type: string) {
  if (type === "command") return Terminal;
  if (type === "open_tab") return Layers;
  if (type === "synonym") return Link2;
  if (type === "trigger") return Zap;
  if (type === "job" || type === "scheduler") return CalendarClock;
  if (type === "sql_file") return FileCode;
  if (type === "sql_library_file") return FileText;
  return null;
}

watch(
  () => props.open,
  (newOpen) => {
    if (newOpen) {
      setQuery("");
      // Eagerly load external SQL files so they appear in the initial list
      void loadExternalSqlFiles();
      focusSearchInput();
    }
  },
);
</script>

<template>
  <Dialog :open="dialogOpen" @update:open="dialogOpen = $event">
    <DialogContent :show-close-button="false" class="max-w-2xl p-0 gap-0 rounded-lg overflow-hidden">
      <div class="flex flex-col bg-background">
        <!-- Search Input -->
        <div class="flex items-center gap-3 px-4 py-3 border-b">
          <Terminal v-if="isCommandMode" class="h-5 w-5 shrink-0 text-primary" />
          <Command v-else class="h-5 w-5 shrink-0 text-muted-foreground" />
          <Input ref="inputRef" v-model="searchQuery" type="text" :placeholder="t('quickOpen.placeholder')" class="flex-1 border-0 bg-transparent p-0 placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:outline-none" @keydown="handleKeyDown" />
          <button
            v-if="!isCommandMode"
            type="button"
            class="shrink-0 rounded border border-border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground cursor-pointer"
            :title="t('quickOpen.commandHintTooltip')"
            @click="enterCommandMode"
          >
            {{ t("quickOpen.commandHintButton") }}
          </button>
          <DialogClose as-child>
            <Button type="button" variant="ghost" size="icon-sm" :aria-label="t('quickOpen.close')">
              <XIcon />
            </Button>
          </DialogClose>
        </div>

        <!-- Results List -->
        <div class="max-h-[400px] overflow-y-auto">
          <div v-if="filteredItems.length === 0" class="px-4 py-8 text-center text-muted-foreground">
            <p v-if="!searchQuery.trim()">{{ t("quickOpen.emptyPlaceholder") }}</p>
            <p v-else>{{ t("quickOpen.noResults") }}</p>
          </div>

          <div v-else class="divide-y">
            <div v-for="(item, index) in filteredItems" :key="item.id" :class="['px-4 py-2 cursor-pointer', index === selectedIndex ? 'bg-accent' : 'hover:bg-muted']" @click="handleSelect(item)" @mouseenter="selectedIndex = index">
              <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 flex-1 min-w-0">
                  <component v-if="getItemIcon(item.type)" :is="getItemIcon(item.type)" class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">
                      <template v-for="(part, i) in getHighlightedLabel(item)" :key="i">
                        <span v-if="typeof part === 'object'" :class="{ 'bg-yellow-200 dark:bg-yellow-800 font-semibold': part.highlight }">
                          {{ part.text }}
                        </span>
                        <span v-else>{{ part }}</span>
                      </template>
                    </div>
                    <div v-if="item.description" class="text-xs text-muted-foreground truncate">
                      {{ item.description }}
                    </div>
                  </div>
                </div>
                <div class="text-xs px-2 py-1 rounded bg-muted text-muted-foreground whitespace-nowrap">
                  {{ getTypeLabel(item.type) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-4 py-2 border-t text-xs text-muted-foreground flex justify-between">
          <div>{{ filteredItems.length }} {{ t("quickOpen.results") }}</div>
          <div class="flex gap-4">
            <span><kbd class="px-2 py-1 rounded bg-muted">↑↓</kbd> {{ t("quickOpen.navigate") }}</span>
            <span><kbd class="px-2 py-1 rounded bg-muted">⏎</kbd> {{ t("quickOpen.select") }}</span>
            <span><kbd class="px-2 py-1 rounded bg-muted">ESC</kbd> {{ t("quickOpen.close") }}</span>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:deep(.bg-yellow-200) {
  background-color: rgb(254 227 92);
}

:deep(.dark .bg-yellow-800) {
  background-color: rgb(92 51 0);
}
</style>
