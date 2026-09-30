import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { compileTemplate, parse } from "vue/compiler-sfc";

const aiAssistantPath = fileURLToPath(new URL("../../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url));
const zhCnLocalePath = fileURLToPath(new URL("../../apps/desktop/src/i18n/locales/zh-CN.ts", import.meta.url));
const source = readFileSync(aiAssistantPath, "utf8");
const zhCnLocaleSource = readFileSync(zhCnLocalePath, "utf8");

test("AI composer keeps templates available without connections", () => {
  const contextRowStart = source.indexOf('<div class="flex items-center gap-1 mb-1 text-xs text-foreground/80">');
  const contextRowEnd = source.indexOf('v-if="mentionOpen"', contextRowStart);
  const contextRow = source.slice(contextRowStart, contextRowEnd);

  assert.notEqual(contextRowStart, -1, "the composer context row should exist");
  assert.notEqual(contextRowEnd, -1, "the connection context row should end before mention suggestions");
  assert.match(contextRow, /<template v-if="connectionStore\.connections\.length">/);
  assert.match(contextRow, /<Popover v-model:open="showTemplateSelector">/);
  assert.match(contextRow, /max-w-\[40%\]/);
  assert.match(contextRow, /<span class="truncate">\{\{ templateSelectorTriggerLabel \}\}<\/span>/);
  assert.match(contextRow, /:aria-label="templateSelectorTriggerLabel"/);
});

test("AI composer labels an empty template selection explicitly", () => {
  assert.match(source, /const templateSelectorTriggerLabel = computed\(\(\) => \{[\s\S]*?templateSelectorLabel.*templateSelectorLabel\.value/);
  assert.match(zhCnLocaleSource, /templateSelectorNone: "未选择"/);
});

test("AI composer exposes mode and action as one compact selector", () => {
  const footerStart = source.indexOf("<!-- Combined mode + action selector -->");
  const footerEnd = source.indexOf("<!-- Combined provider + model selector -->", footerStart);
  const footer = source.slice(footerStart, footerEnd);

  assert.notEqual(footerStart, -1, "the combined mode and action selector should exist");
  assert.notEqual(footerEnd, -1, "the model selector should follow the combined selector");
  assert.match(footer, /<Popover v-model:open="modeActionOpen">/);
  assert.match(footer, /:aria-label="modeActionTriggerLabel"/);
  assert.match(footer, /switchModeActionTab\('ask'\)/);
  assert.match(footer, /switchModeActionTab\('agent'\)/);
  assert.match(footer, /selectModeActionItem\(button\.action\)/);
  assert.doesNotMatch(footer, /selectAction\(button\.action\)/);
  assert.match(footer, /<template v-if="showActionButtons">[\s\S]*?<div class="border-t my-1" \/>[\s\S]*?v-for="button in actionButtons"/);
  assert.match(source, /function selectModeActionItem\(action: AiAction\) \{\s*\/\/ Vector databases[\s\S]*?if \(!showActionButtons\.value\) return;/);
});

test("AI effort control is a direct composer popover beside the model selector", () => {
  const selectorStart = source.indexOf("<!-- Combined provider + model selector -->");
  const effortStart = source.indexOf('<Popover v-if="settings.activeModel" v-model:open="effortMenuOpen">', selectorStart);
  const effortEnd = source.indexOf("</Popover>", effortStart) + "</Popover>".length;
  const effortPopover = source.slice(effortStart, effortEnd);
  const providerSelector = source.slice(selectorStart, effortStart);

  assert.notEqual(selectorStart, -1, "the combined provider and model selector should exist");
  assert.notEqual(effortStart, -1, "the direct effort selector should follow the model selector");
  assert.ok(effortStart > selectorStart);
  assert.match(source.slice(effortStart - 80, effortStart), /<\/Popover>\s*$/);
  assert.doesNotMatch(providerSelector, /effortMenuOpen|ai\.effort/);
  assert.match(effortPopover, /<PopoverTrigger as-child>[\s\S]*?<button\s+type="button"/);
  assert.match(effortPopover, /:title="`\$\{t\('ai\.effort'\)\}: \$\{effortSelectionLabel\(settings\.activeEffort\)\}`"/);
  assert.match(effortPopover, /focus-visible:ring-primary/);
  assert.match(effortPopover, /effortSelectionLabel\(settings\.activeEffort\)/);
  assert.match(effortPopover, /<PopoverContent[\s\S]*?side="top"[\s\S]*?align="end"[\s\S]*?:collision-padding="8"/);
  assert.match(effortPopover, /@click="selectEffortOption\(option\)"/);
  assert.doesNotMatch(effortPopover, /@mouseenter|@mouseleave|@focus=/);
  assert.doesNotMatch(source, /effortMenuCloseTimer|scheduleEffortMenuClose|openEffortMenu/);
});

test("AI effort menu separates configuration default from provider default", () => {
  const popoverStart = source.indexOf('<Popover v-if="settings.activeModel" v-model:open="effortMenuOpen">');
  const popoverEnd = source.indexOf("</Popover>", popoverStart) + "</Popover>".length;
  const effortPopover = source.slice(popoverStart, popoverEnd);
  const labelStart = source.indexOf("function effortSelectionLabel");
  const labelEnd = source.indexOf("function retryActiveEffort", labelStart);
  const effortLabel = source.slice(labelStart, labelEnd);

  assert.match(effortPopover, /:class="!settings\.activeEffort \? 'bg-accent text-accent-foreground' : ''"[\s\S]*?@click="selectEffort\(null\)"[\s\S]*?t\("ai\.configDefaultEffort"\)[\s\S]*?<Check v-if="!settings\.activeEffort"/);
  assert.match(effortPopover, /:class="settings\.activeEffort\?\.kind === 'providerDefault' \? 'bg-accent text-accent-foreground' : ''"[\s\S]*?@click="selectEffort\(\{ kind: 'providerDefault' \}\)"[\s\S]*?<Check v-if="settings\.activeEffort\?\.kind === 'providerDefault'"/);
  assert.match(source, /function selectEffort\(selection: AiEffortSelection \| null\)[\s\S]*?settings\.updateActiveEffort\(selection\)/);
  assert.match(effortLabel, /if \(!selection\)[\s\S]*?configuredLevel[\s\S]*?return t\("ai\.configDefaultEffort"\)/);
  assert.match(effortLabel, /if \(selection\.kind === "providerDefault"\) return t\("ai\.providerDefault"\);/);
});

test("AI model and effort menu refreshes do not persist effort settings", () => {
  const loaderStart = source.indexOf("async function ensureModelEffort");
  const loaderEnd = source.indexOf("function handleModelSelect", loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);

  assert.notEqual(loaderStart, -1, "the effort capability loader should exist");
  assert.notEqual(loaderEnd, -1, "the model selection handler should follow the effort loader");
  assert.match(loader, /await resolveEffort\(config, modelId, force\)/);
  assert.doesNotMatch(loader, /updateActiveEffort|persistAiChatSelection/);
});

test("AI composer allocates selector widths independently of their labels", () => {
  const { descriptor } = parse(source, { filename: aiAssistantPath });
  const style = descriptor.styles[0].content;
  assert.match(source, /class="ai-composer-controls"/);
  assert.match(source, /class="ai-composer-model-controls"/);
  assert.match(style, /container: ai-composer \/ inline-size/);
  assert.match(style, /\.ai-composer-model-controls--with-effort\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(source, /flex min-w-0 flex-nowrap items-center gap-1\.5 overflow-hidden/);
  assert.doesNotMatch(source, /max-w-\[150px\]|max-w-\[220px\]/);
});

test("AI composer responds to sidebar width rather than the app viewport", () => {
  const { descriptor } = parse(source, { filename: aiAssistantPath });
  const style = descriptor.styles[0].content;
  assert.match(style, /\.ai-composer-toolbar--with-models\s*\{\s*grid-template-areas:\s*"mode send"\s*"models models"/);
  assert.match(style, /@container ai-composer \(min-width: 520px\)[\s\S]*?grid-template-areas: "mode models send"/);
  assert.match(style, /@container ai-composer \(max-width: 299px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
});

test("AI composer keeps full names accessible when text is truncated", () => {
  assert.match(source, /:title="modeActionTriggerLabel"/);
  assert.match(source, /:title="activeFullConfig\?\.model \|\| t\('ai\.selectModel'\)"/);
  assert.match(source, /min-w-0 flex-1 truncate text-left"\s*>\{\{ t\("ai\.effort"\) \}\}/);
  assert.match(source, /class="ai-composer-submit h-7 w-7 shrink-0/g);
});

test("AI composer template remains compilable", () => {
  const { descriptor, errors } = parse(source, { filename: aiAssistantPath });
  assert.deepEqual(errors, []);
  assert.ok(descriptor.template);

  const result = compileTemplate({ id: aiAssistantPath, filename: aiAssistantPath, source: descriptor.template.content });
  assert.deepEqual(result.errors, []);
});
