<script setup lang="ts">
import { computed } from "vue";
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import LightDropdown, { type LightDropdownItem } from "@/components/ui/LightDropdown.vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSelectionNumber, formatSelectionSummaryText, type SelectionSummary } from "@/lib/dataGrid/gridSelection";
import { MAX_RESULT_PAGE_SIZE, MIN_RESULT_PAGE_SIZE } from "@/lib/dataGrid/paginationPageSize";
import DataGridExportMenu from "@/components/grid/DataGridExportMenu.vue";

const { t } = useI18n();
const { toast } = useToast();

const props = withDefaults(
  defineProps<{
    paginationEnabled?: boolean;
    selectionSummary: (Partial<SelectionSummary> & { cellCount: number; rowCount: number }) | null;
    selectionSummarySumText: string;
    loading: boolean;
    infiniteScrollEnabled: boolean;
    infiniteScrollAllLoaded: boolean;
    pageSize: number;
    pageSizeMenuItems: LightDropdownItem[];
    exportMenuItems: LightDropdownItem[];
    currentPage: number;
    canGoNextPage: boolean;
    canJumpLastPage: boolean;
  }>(),
  { paginationEnabled: true },
);

const customPageSizeInput = defineModel<string>("customPageSizeInput", { default: "" });

const emit = defineEmits<{
  selectPageSize: [value: string];
  applyCustomPageSize: [];
  firstPage: [];
  previousPage: [];
  nextPage: [];
  lastPage: [];
  selectExport: [value: string];
}>();

const hasNumericSummary = computed(() => (props.selectionSummary?.numericCount ?? 0) > 0);
const resolvedSumText = computed(() => props.selectionSummarySumText || (props.selectionSummary?.sum != null ? formatSelectionNumber(props.selectionSummary.sum) : "-"));
const formattedAvg = computed(() => (props.selectionSummary?.avg != null ? formatSelectionNumber(props.selectionSummary.avg) : null));
const formattedMin = computed(() => (props.selectionSummary?.min != null ? formatSelectionNumber(props.selectionSummary.min) : null));
const formattedMax = computed(() => (props.selectionSummary?.max != null ? formatSelectionNumber(props.selectionSummary.max) : null));

async function copySelectionStats() {
  const summary = props.selectionSummary;
  if (!summary) return;
  const cellsLabel = t("grid.selectionCells", { count: "" }).trim() || "Cells";
  const text = formatSelectionSummaryText(summary, {
    cells: cellsLabel,
    rows: t("grid.rowCount"),
    nonNull: t("grid.selectionNonNull"),
    nulls: t("grid.selectionNulls"),
    distinct: t("grid.selectionDistinct"),
    numeric: t("grid.selectionNumericCount"),
    sum: t("grid.selectionSumLabel"),
    avg: t("grid.selectionAvgLabel"),
    min: t("grid.selectionMinLabel"),
    max: t("grid.selectionMaxLabel"),
  });
  try {
    await copyToClipboard(text);
    toast(t("grid.selectionStatsCopied"), 2000);
  } catch (error: any) {
    toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
  }
}
</script>

<template>
  <div class="flex min-w-max items-center justify-end gap-1">
    <Popover v-if="selectionSummary">
      <PopoverTrigger as-child>
        <button type="button" class="inline-flex h-5 shrink-0 cursor-pointer items-center gap-2.5 rounded-md px-1.5 text-xs tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <template v-if="hasNumericSummary">
            <span class="shrink-0 text-foreground/90">{{ t("grid.selectionSum", { value: resolvedSumText }) }}</span>
            <span v-if="formattedAvg !== null" class="shrink-0">{{ t("grid.selectionAvgShort", { value: formattedAvg }) }}</span>
          </template>
          <template v-else>
            <span class="shrink-0 text-foreground/90">{{ t("grid.selectionCountShort", { count: selectionSummary.nonNullCount ?? selectionSummary.cellCount }) }}</span>
            <span v-if="selectionSummary.distinctCount != null" class="shrink-0">{{ t("grid.selectionDistinctShort", { count: selectionSummary.distinctCount }) }}</span>
          </template>
          <span class="flex shrink-0 items-center gap-1">
            <span class="shrink-0">{{ t("grid.selectionCells", { count: selectionSummary.cellCount }) }}</span>
            <span class="shrink-0">{{ t("grid.rows", { count: selectionSummary.rowCount }) }}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" class="w-64 p-2.5 text-xs">
        <div class="flex items-center justify-between gap-2 border-b pb-1.5">
          <span class="font-medium text-foreground">{{ t("grid.selectionStatsTitle") }}</span>
          <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums"> {{ t("grid.selectionCells", { count: selectionSummary.cellCount }) }} · {{ t("grid.rows", { count: selectionSummary.rowCount }) }} </span>
        </div>

        <div class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 tabular-nums">
          <span class="text-muted-foreground">{{ t("grid.selectionNonNull") }}</span>
          <span class="text-right font-medium text-foreground">{{ selectionSummary.nonNullCount != null ? formatSelectionNumber(selectionSummary.nonNullCount) : "-" }}</span>

          <span class="text-muted-foreground">{{ t("grid.selectionNulls") }}</span>
          <span class="text-right font-medium text-foreground">{{ formatSelectionNumber(selectionSummary.nullCount ?? 0) }}</span>

          <span class="text-muted-foreground">{{ t("grid.selectionDistinct") }}</span>
          <span class="text-right font-medium text-foreground">{{ selectionSummary.distinctCount != null ? formatSelectionNumber(selectionSummary.distinctCount) : "-" }}</span>
        </div>

        <template v-if="hasNumericSummary">
          <div class="h-px bg-border" />
          <div class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 tabular-nums">
            <span class="text-muted-foreground">{{ t("grid.selectionNumericCount") }}</span>
            <span class="text-right font-medium text-foreground">{{ selectionSummary.numericCount != null ? formatSelectionNumber(selectionSummary.numericCount) : "-" }}</span>

            <span class="text-muted-foreground">{{ t("grid.selectionSumLabel") }}</span>
            <span class="text-right font-medium text-foreground">{{ resolvedSumText }}</span>

            <span class="text-muted-foreground">{{ t("grid.selectionAvgLabel") }}</span>
            <span class="text-right font-medium text-foreground">{{ formattedAvg ?? "-" }}</span>

            <span class="text-muted-foreground">{{ t("grid.selectionMinLabel") }}</span>
            <span class="text-right font-medium text-foreground">{{ formattedMin ?? "-" }}</span>

            <span class="text-muted-foreground">{{ t("grid.selectionMaxLabel") }}</span>
            <span class="text-right font-medium text-foreground">{{ formattedMax ?? "-" }}</span>
          </div>
        </template>

        <Button variant="outline" size="sm" class="h-7 w-full justify-center gap-1.5 text-xs" @click="copySelectionStats">
          <Copy class="h-3 w-3" />
          <span>{{ t("grid.copySelectionStats") }}</span>
        </Button>
      </PopoverContent>
    </Popover>
    <Loader2 v-if="loading" class="w-3 h-3 animate-spin text-muted-foreground" />
    <template v-if="paginationEnabled && infiniteScrollEnabled">
      <span v-if="infiniteScrollAllLoaded" class="text-xs text-muted-foreground shrink-0">{{ t("grid.allLoaded") }}</span>
    </template>
    <template v-if="paginationEnabled && !infiniteScrollEnabled">
      <LightDropdown
        :model-value="String(pageSize)"
        :items="pageSizeMenuItems"
        :trigger-label="`${pageSize}${t('grid.rowsPerPageShort')}`"
        trigger-class="inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
        content-class="w-36"
        :highlight-selected="false"
        check-position="none"
        align="end"
        @update:model-value="emit('selectPageSize', $event)"
      >
        <div class="bg-border -mx-1 my-1 h-px" />
        <div class="text-muted-foreground px-1.5 py-1 text-xs">{{ t("grid.customRowsPerPage") }}</div>
        <div class="flex items-center gap-1 px-1.5 pb-1" @click.stop @keydown.stop>
          <Input
            v-model="customPageSizeInput"
            type="number"
            inputmode="numeric"
            :min="MIN_RESULT_PAGE_SIZE"
            :max="MAX_RESULT_PAGE_SIZE"
            class="h-6 w-20 px-1.5 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            @keydown.enter.prevent.stop="emit('applyCustomPageSize')"
          />
          <Tooltip>
            <TooltipTrigger as-child
              ><Button variant="outline" size="icon" class="h-6 w-6 shrink-0" :aria-label="t('grid.applyPageSize')" @click.stop="emit('applyCustomPageSize')"><Check class="h-3 w-3" /></Button
            ></TooltipTrigger>
            <TooltipContent side="bottom">{{ t("grid.applyPageSize") }}</TooltipContent>
          </Tooltip>
        </div>
      </LightDropdown>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || currentPage <= 1" @click="emit('firstPage')"><ChevronsLeft class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || currentPage <= 1" @click="emit('previousPage')"><ChevronLeft class="h-3 w-3" /></Button>
      <span class="shrink-0 tabular-nums">{{ currentPage }}</span>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || !canGoNextPage" @click="emit('nextPage')"><ChevronRight class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="loading || !canJumpLastPage" @click="emit('lastPage')"><ChevronsRight class="h-3 w-3" /></Button>
    </template>
    <DataGridExportMenu :items="exportMenuItems" :label="t('grid.export')" :on-select="(value) => emit('selectExport', value)" />
  </div>
</template>
