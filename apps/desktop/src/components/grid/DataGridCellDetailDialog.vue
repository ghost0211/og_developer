<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Binary, Code2, Copy, Download, Eye, FileCode, FileText, FolderTree, ImageIcon, Info, KeyRound, MapPin, Pencil, WrapText } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import JsonTree from "@/components/common/JsonTree.vue";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { BINARY_CELL_DOWNLOAD_MODES, type BinaryCellDownloadMode } from "@/lib/dataGrid/binaryCellDownload";
import { isGeometryColumnType } from "@/lib/dataGrid/cellDetailPresentation";
import { isHexGeometry, renderWktOnCanvas } from "@/lib/dataGrid/geometryPreview";
import { detectBase64Info, formatXml, isWellFormedXml, isWktGeometryText } from "@/lib/dataGrid/richValueDetection";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();

const props = defineProps<{
  detail: DataGridCellDetail | null;
  typeColorClass: (type: string) => string;
  openImagePreview: (src: string, title: string) => void;
  copyText: (text: string) => void;
  canDownloadBinaryValue: (detail: DataGridCellDetail | null) => boolean;
  downloadBinaryValue: (detail: DataGridCellDetail | null, mode: BinaryCellDownloadMode) => void | Promise<void>;
}>();

const emit = defineEmits<{
  edit: [];
}>();

const open = defineModel<boolean>("open", { default: false });

type ViewerFormat = "text" | "json_tree" | "json_code" | "xml" | "image" | "hex" | "base64" | "geometry";
const activeFormat = ref<ViewerFormat>("text");
const wordWrap = ref(true);
const geometryCanvas = ref<HTMLCanvasElement | null>(null);
const jsonPreviewContainer = ref<HTMLElement>();
let jsonPreviewEditor: UseCellDetailEditorReturn | null = null;

// Raw String Value
const rawString = computed(() => {
  if (!props.detail || props.detail.value === null || props.detail.value === undefined) return "";
  return String(props.detail.value);
});

// JSON parsing
const parsedJson = computed<{ valid: boolean; data?: unknown; formatted?: string }>(() => {
  if (props.detail?.formattedJson) {
    try {
      const data = JSON.parse(props.detail.rawValue || rawString.value);
      return { valid: true, data, formatted: props.detail.formattedJson };
    } catch {
      // fallback
    }
  }
  const str = rawString.value.trim();
  if (!str || (!str.startsWith("{") && !str.startsWith("["))) return { valid: false };
  try {
    const data = JSON.parse(str);
    const formatted = JSON.stringify(data, null, 2);
    return { valid: true, data, formatted };
  } catch {
    return { valid: false };
  }
});

// XML parsing & formatting
const parsedXml = computed<{ valid: boolean; formatted?: string }>(() => {
  const str = rawString.value;
  if (!isWellFormedXml(str)) return { valid: false };
  return { valid: true, formatted: formatXml(str) };
});

// Base64 detection & decoding
const base64Info = computed(() => detectBase64Info(rawString.value));

// Image preview URL
const detectedImageUrl = computed(() => {
  if (props.detail?.imagePreviewUrl) return props.detail.imagePreviewUrl;
  if (base64Info.value.isImage && base64Info.value.imageUrl) return base64Info.value.imageUrl;
  const str = rawString.value.trim();
  if (str.startsWith("http://") || str.startsWith("https://")) {
    if (/\.(png|jpe?g|gif|webp|svg|ico)(\?.*)?$/i.test(str)) return str;
  }
  return null;
});

// Hex Dump
const hexDumpText = computed(() => generateHexDump(rawString.value));

// WKT Geometry detection
const isWktGeometry = computed(() => {
  if (!props.detail) return false;
  if (isGeometryColumnType(props.detail.type) && props.detail.value !== null && !isHexGeometry(props.detail.value as string)) {
    return true;
  }
  return isWktGeometryText(rawString.value);
});

// Auto-detect best format when cell detail changes
function autoDetectFormat() {
  if (detectedImageUrl.value) {
    activeFormat.value = "image";
  } else if (parsedJson.value.valid) {
    activeFormat.value = "json_code";
  } else if (parsedXml.value.valid) {
    activeFormat.value = "xml";
  } else if (isWktGeometry.value) {
    activeFormat.value = "geometry";
  } else if (base64Info.value.isBase64) {
    activeFormat.value = "base64";
  } else {
    activeFormat.value = "text";
  }
}

watch(
  () => props.detail,
  (detail) => {
    if (detail) {
      // NULL values must always open in the plain-text view rather than
      // inheriting the previous cell's JSON/XML/image format.
      activeFormat.value = "text";
      if (detail.value !== null) autoDetectFormat();
      if (isWktGeometry.value) void renderGeometry();
    } else if (jsonPreviewEditor) {
      jsonPreviewEditor.destroy();
      jsonPreviewEditor = null;
    }
  },
  { immediate: true },
);

watch(activeFormat, (fmt) => {
  if (fmt === "geometry") {
    void renderGeometry();
  }
});

async function renderGeometry() {
  await nextTick();
  const canvas = geometryCanvas.value;
  if (canvas && rawString.value) {
    renderWktOnCanvas(canvas, rawString.value);
  }
}

// CodeMirror Editor for JSON code view
watch(jsonPreviewContainer, async (element) => {
  if (element && !jsonPreviewEditor) {
    jsonPreviewEditor = useCellDetailEditor({
      language: "json",
      readOnly: true,
      editorTheme: () => settingsStore.editorSettings.theme,
      appAppearance: () => (isDark.value ? "dark" : "light"),
      appPalette: () => themePalette.value,
      fontSize: () => settingsStore.editorSettings.fontSize,
      fontFamily: () => settingsStore.editorSettings.tableFontFamily,
    });
    await jsonPreviewEditor.create(element, parsedJson.value.formatted || props.detail?.formattedJson || "", "json");
  } else if (!element && jsonPreviewEditor) {
    jsonPreviewEditor.destroy();
    jsonPreviewEditor = null;
  }
});

watch(
  () => props.detail?.formattedJson ?? parsedJson.value.formatted ?? "",
  (value) => {
    if (value && jsonPreviewEditor) {
      jsonPreviewEditor.setValue(value, "json");
    }
  },
);

// Actions
function copyCurrentValue() {
  const detail = props.detail;
  if (!detail) return;
  let textToCopy = detail.value === null ? "" : detail.rawValue;
  if (activeFormat.value === "json_code" || activeFormat.value === "json_tree") {
    textToCopy = detail.formattedJson || parsedJson.value.formatted || textToCopy;
  } else if (activeFormat.value === "xml") {
    textToCopy = parsedXml.value.formatted || textToCopy;
  } else if (activeFormat.value === "hex") {
    textToCopy = hexDumpText.value;
  } else if (activeFormat.value === "base64") {
    textToCopy = base64Info.value.text || textToCopy;
  }
  props.copyText(textToCopy);
}

function copyColumnName() {
  if (props.detail) props.copyText(props.detail.column);
}

function downloadTextAsFile(ext: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${props.detail?.column || "cell_value"}_${Date.now()}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已下载为 .${ext} 文件`, 1500);
}

function generateHexDump(val: string): string {
  const bytes = new TextEncoder().encode(val);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const offset = i.toString(16).padStart(8, "0");
    const slice = bytes.slice(i, i + 16);
    const hexParts: string[] = [];
    let asciiPart = "";

    for (let j = 0; j < 16; j++) {
      if (j < slice.length) {
        const b = slice[j];
        hexParts.push(b.toString(16).padStart(2, "0"));
        asciiPart += b >= 32 && b <= 126 ? String.fromCharCode(b) : ".";
      } else {
        hexParts.push("  ");
      }
      if (j === 7) hexParts.push("");
    }

    lines.push(`${offset}  ${hexParts.join(" ")}  |${asciiPart}|`);
    if (lines.length >= 300) {
      lines.push(`... [已截断，总长度 ${bytes.length} 字节]`);
      break;
    }
  }
  return lines.join("\n");
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="detail" class="sm:max-w-[920px] h-[88vh] max-h-[92vh] flex flex-col overflow-hidden p-0 gap-0 border bg-background text-foreground shadow-2xl">
      <!-- Header -->
      <DialogHeader class="px-4 py-2.5 border-b bg-muted/30 shrink-0 flex flex-row items-center justify-between space-y-0 select-none">
        <DialogTitle class="flex items-center gap-2 text-sm font-semibold">
          <Info class="h-4 w-4 text-primary" />
          <span>{{ t("grid.cellDetails", "单元格富内容详情") }}</span>
          <Badge variant="outline" class="text-xs font-mono font-normal">
            {{ detail.column }}
          </Badge>
          <Badge v-if="detail.type" variant="secondary" class="text-[11px] font-mono" :class="typeColorClass(detail.type)">
            {{ detail.type }}
          </Badge>
        </DialogTitle>

        <!-- Right Quick Action Controls -->
        <div class="flex items-center gap-1.5 pr-6">
          <Button
            v-if="detail.isEditable"
            variant="outline"
            size="sm"
            class="h-6 gap-1 px-2 text-xs"
            :title="t('grid.editValue')"
            @click="
              emit('edit');
              open = false;
            "
          >
            <Pencil class="h-3 w-3" />
            <span>{{ t("grid.editValue", "编辑数值") }}</span>
          </Button>

          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" :title="t('grid.copyValue')" @click="copyCurrentValue">
            <Copy class="h-3 w-3" />
            <span>{{ t("grid.copyValue", "复制内容") }}</span>
          </Button>

          <!-- Download Menu -->
          <DropdownMenu v-if="detail">
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" :title="t('grid.downloadBinaryValue')">
                <Download class="h-3 w-3" />
                <span>导出文件</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="text-xs">
              <DropdownMenuItem v-if="parsedJson.valid" @click="downloadTextAsFile('json', parsedJson.formatted || rawString)"> 下载为 .json 文件 </DropdownMenuItem>
              <DropdownMenuItem v-if="parsedXml.valid" @click="downloadTextAsFile('xml', parsedXml.formatted || rawString)"> 下载为 .xml 文件 </DropdownMenuItem>
              <DropdownMenuItem @click="downloadTextAsFile('txt', rawString)"> 下载为 .txt 纯文本 </DropdownMenuItem>
              <DropdownMenuItem @click="downloadTextAsFile('hex.txt', hexDumpText)"> 下载为 Hex 字节码文本 </DropdownMenuItem>
              <template v-if="canDownloadBinaryValue(detail)">
                <DropdownMenuItem v-for="mode in BINARY_CELL_DOWNLOAD_MODES" :key="mode" @click="downloadBinaryValue(detail, mode)">
                  {{ t(`grid.binaryDownload.${mode}`) }}
                </DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </DialogHeader>

      <!-- Metadata summary strip -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 py-1.5 bg-muted/20 border-b text-xs shrink-0 select-none">
        <div class="flex items-center gap-1.5 truncate">
          <span class="text-muted-foreground">{{ t("grid.rowNumber", "行号") }}:</span>
          <span class="font-mono font-medium">{{ detail.rowNumber }}</span>
        </div>
        <div class="flex items-center gap-1.5 truncate">
          <span class="text-muted-foreground">{{ t("grid.valueLength", "字符长度") }}:</span>
          <span class="font-mono font-medium">{{ detail.length }} chars</span>
        </div>
        <div class="flex items-center gap-1.5 truncate">
          <span class="text-muted-foreground">是否为 NULL:</span>
          <span class="font-mono font-medium" :class="detail.value === null ? 'text-amber-500 font-bold' : ''">{{ detail.value === null ? "NULL" : "False" }}</span>
        </div>
        <div class="flex items-center gap-1.5 truncate">
          <span class="text-muted-foreground">{{ t("grid.columnComment", "列注释") }}:</span>
          <span class="truncate text-foreground/80" :title="detail.comment || t('grid.noComment')">{{ detail.comment || "-" }}</span>
        </div>
      </div>

      <!-- Format Switcher Sub-Toolbar -->
      <div class="flex items-center justify-between border-b bg-muted/10 px-4 py-1 text-xs shrink-0 select-none">
        <div class="flex items-center gap-1 overflow-x-auto">
          <!-- Text Tab -->
          <button type="button" class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all" :class="activeFormat === 'text' ? 'bg-primary text-primary-foreground font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'" @click="activeFormat = 'text'">
            <FileText class="h-3 w-3" />
            <span>纯文本 (Text)</span>
          </button>

          <!-- JSON Tree Tab -->
          <button
            v-if="parsedJson.valid"
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all"
            :class="activeFormat === 'json_tree' ? 'bg-emerald-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'"
            @click="activeFormat = 'json_tree'"
          >
            <FolderTree class="h-3 w-3" />
            <span>JSON 树形</span>
          </button>

          <!-- JSON Code Tab -->
          <button
            v-if="parsedJson.valid"
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all"
            :class="activeFormat === 'json_code' ? 'bg-emerald-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'"
            @click="activeFormat = 'json_code'"
          >
            <Code2 class="h-3 w-3" />
            <span>JSON 编辑器</span>
          </button>

          <!-- XML Tab -->
          <button v-if="parsedXml.valid" type="button" class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all" :class="activeFormat === 'xml' ? 'bg-blue-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'" @click="activeFormat = 'xml'">
            <FileCode class="h-3 w-3" />
            <span>XML / HTML</span>
          </button>

          <!-- Image Tab -->
          <button
            v-if="detectedImageUrl"
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all"
            :class="activeFormat === 'image' ? 'bg-purple-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'"
            @click="activeFormat = 'image'"
          >
            <ImageIcon class="h-3 w-3" />
            <span>图片 (Image)</span>
          </button>

          <!-- Base64 Tab -->
          <button
            v-if="base64Info.isBase64"
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all"
            :class="activeFormat === 'base64' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'"
            @click="activeFormat = 'base64'"
          >
            <KeyRound class="h-3 w-3" />
            <span>Base64 解码</span>
          </button>

          <!-- Hex Dump Tab -->
          <button type="button" class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all" :class="activeFormat === 'hex' ? 'bg-slate-700 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'" @click="activeFormat = 'hex'">
            <Binary class="h-3 w-3" />
            <span>Hex 字节码</span>
          </button>

          <!-- Geometry Tab -->
          <button
            v-if="isWktGeometry"
            type="button"
            class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-all"
            :class="activeFormat === 'geometry' ? 'bg-amber-600 text-white font-semibold shadow-sm' : 'text-muted-foreground hover:bg-muted'"
            @click="activeFormat = 'geometry'"
          >
            <MapPin class="h-3 w-3" />
            <span>空间几何 (Spatial)</span>
          </button>
        </div>

        <!-- Word wrap controls -->
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" class="h-6 gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground" :class="{ 'bg-muted text-foreground': wordWrap }" @click="wordWrap = !wordWrap">
            <WrapText class="h-3.5 w-3.5" />
            <span>换行</span>
          </Button>
        </div>
      </div>

      <!-- Main Viewer Area -->
      <div class="flex-1 min-h-0 relative p-3 overflow-hidden bg-muted/10">
        <!-- 1. Text Viewer -->
        <div v-if="activeFormat === 'text'" class="h-full w-full overflow-auto rounded border bg-background p-3 font-mono text-xs">
          <div v-if="detail.value === null" class="italic text-muted-foreground/60 p-4 text-center">NULL (空值)</div>
          <pre v-else class="leading-relaxed" :class="wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'">{{ rawString }}</pre>
        </div>

        <!-- 2. JSON Tree Viewer -->
        <div v-else-if="activeFormat === 'json_tree'" class="h-full w-full overflow-auto rounded border bg-background p-3">
          <JsonTree :value="parsedJson.data" :virtualized="false" class="font-mono text-xs leading-6" />
        </div>

        <!-- 3. JSON CodeMirror Viewer -->
        <div v-else-if="activeFormat === 'json_code'" ref="jsonPreviewContainer" data-cell-detail-editor-root class="h-full w-full overflow-hidden rounded border bg-background p-1" />

        <!-- 4. XML / HTML Viewer -->
        <div v-else-if="activeFormat === 'xml'" class="h-full w-full overflow-auto rounded border bg-background p-3 font-mono text-xs">
          <pre class="leading-relaxed whitespace-pre font-mono text-blue-600 dark:text-sky-400">{{ parsedXml.formatted || rawString }}</pre>
        </div>

        <!-- 5. Image Viewer -->
        <div v-else-if="activeFormat === 'image'" class="h-full w-full flex flex-col items-center justify-center p-4 rounded border bg-background overflow-auto gap-3">
          <div class="max-h-[50vh] max-w-full overflow-auto border rounded p-2 bg-muted/30 shadow-inner">
            <img :src="detectedImageUrl!" :alt="detail.column" class="max-h-[48vh] max-w-full object-contain rounded" />
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" variant="outline" class="h-7 text-xs gap-1" @click="openImagePreview(detectedImageUrl!, detail.column)">
              <Eye class="h-3.5 w-3.5" />
              <span>全屏大图查看</span>
            </Button>
          </div>
        </div>

        <!-- 6. Hex Dump Viewer -->
        <div v-else-if="activeFormat === 'hex'" class="h-full w-full overflow-auto rounded border bg-background p-3 font-mono text-xs leading-relaxed">
          <pre class="whitespace-pre font-mono text-foreground select-text">{{ hexDumpText }}</pre>
        </div>

        <!-- 7. Base64 Decoded Viewer -->
        <div v-else-if="activeFormat === 'base64'" class="h-full w-full flex flex-col gap-2 overflow-auto rounded border bg-background p-3 font-mono text-xs">
          <div class="text-[11px] text-muted-foreground font-sans">Base64 解码明文 (Decoded UTF-8 Text):</div>
          <div v-if="base64Info.isImage" class="p-2 border rounded bg-muted/20 flex flex-col items-center">
            <img :src="base64Info.imageUrl!" class="max-h-48 object-contain rounded mb-2" />
            <Badge variant="outline">已识别为 Base64 嵌入图片</Badge>
          </div>
          <pre class="flex-1 min-h-0 overflow-auto rounded border bg-muted/20 p-2 text-xs leading-relaxed" :class="wordWrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'">{{ base64Info.text || rawString }}</pre>
        </div>

        <!-- 8. Spatial / Geometry Canvas Viewer -->
        <div v-else-if="activeFormat === 'geometry'" class="h-full w-full flex flex-col items-center justify-center p-4 rounded border bg-background overflow-auto gap-2">
          <canvas ref="geometryCanvas" width="560" height="360" class="border rounded bg-muted/20 shadow-sm block" />
          <div class="text-[11px] text-muted-foreground font-mono truncate max-w-lg" :title="rawString">
            {{ rawString }}
          </div>
        </div>
      </div>

      <!-- Footer -->
      <DialogFooter class="px-4 py-2 border-t bg-muted/20 shrink-0 flex flex-row items-center justify-between select-none">
        <Button variant="ghost" size="sm" class="h-7 text-xs text-muted-foreground hover:text-foreground" @click="copyColumnName">
          <Copy class="mr-1.5 h-3 w-3" />
          <span>{{ t("grid.copyColumnName", "复制列名") }}</span>
        </Button>

        <Button variant="outline" size="sm" class="h-7 text-xs px-4" @click="open = false">
          <span>关闭</span>
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
