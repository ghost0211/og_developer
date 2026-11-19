<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ExternalLink, Loader2, RefreshCw, Sparkles, Tag } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { currentLocale } from "@/i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { changelogLangFromLocale, changelogReleaseUrl, changelogWebsiteUrl, createLatestRequestGuard, fetchChangelog, getBundledChangelogReleases, type ChangelogLang, type ChangelogRelease } from "@/lib/app/changelog";

const PAGE_SIZE = 5;

const props = withDefaults(
  defineProps<{
    compact?: boolean;
    currentVersion?: string;
    defaultExpandCount?: number;
    showHeader?: boolean;
  }>(),
  {
    compact: false,
    currentVersion: "",
    defaultExpandCount: 1,
    showHeader: true,
  },
);

const { t, locale } = useI18n();

const loading = ref(false);
const fromRemote = ref<boolean | null>(null);
const changelogLang = computed(() => changelogLangFromLocale(locale.value || currentLocale()));
const releases = ref<ChangelogRelease[]>(getBundledChangelogReleases(changelogLang.value));
const visibleCount = ref(PAGE_SIZE);
const expandedTags = ref<Set<string>>(new Set(releases.value.slice(0, Math.max(0, props.defaultExpandCount)).map((item) => item.tag)));
const loadedLang = ref<ChangelogLang | null>(null);
const loadRequest = createLatestRequestGuard();

const visibleReleases = computed(() => releases.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < releases.value.length);
const latestTag = computed(() => releases.value[0]?.tag ?? "");
const normalizedCurrentTag = computed(() => {
  const trimmed = props.currentVersion?.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
});

function isLatestRelease(tag: string) {
  return !!latestTag.value && tag === latestTag.value;
}

function isCurrentRelease(tag: string) {
  return !!normalizedCurrentTag.value && tag === normalizedCurrentTag.value;
}

function sectionDotClass(type: string) {
  switch (type) {
    case "improved":
      return "bg-sky-500";
    case "fixed":
      return "bg-amber-500";
    case "changed":
      return "bg-violet-500";
    case "removed":
      return "bg-destructive";
    default:
      return "bg-emerald-500";
  }
}

function sectionLabel(type: string, fallback: string) {
  const keyByType: Record<string, string> = {
    added: "settings.changelogSectionAdded",
    improved: "settings.changelogSectionImproved",
    fixed: "settings.changelogSectionFixed",
    changed: "settings.changelogSectionChanged",
    removed: "settings.changelogSectionRemoved",
  };
  const key = keyByType[type];
  if (!key) return fallback;
  const translated = t(key);
  return translated === key ? fallback : translated;
}

function formatReleaseDate(dateStr: string) {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  try {
    return new Intl.DateTimeFormat(locale.value || currentLocale(), {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  } catch {
    return dateStr;
  }
}

function openExternalUrl(url: string) {
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function isExpanded(tag: string) {
  return expandedTags.value.has(tag);
}

function toggleRelease(tag: string) {
  const next = new Set(expandedTags.value);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  expandedTags.value = next;
}

function loadMore() {
  visibleCount.value = Math.min(visibleCount.value + PAGE_SIZE, releases.value.length);
}

function seedExpandedTags(nextReleases: ChangelogRelease[]) {
  if (expandedTags.value.size > 0) return;
  expandedTags.value = new Set(nextReleases.slice(0, Math.max(0, props.defaultExpandCount)).map((item) => item.tag));
}

async function load(force = false) {
  const lang = changelogLang.value;
  const requestId = loadRequest.begin();
  loading.value = true;
  if (force || loadedLang.value !== lang) {
    const bundled = getBundledChangelogReleases(lang);
    releases.value = bundled;
    seedExpandedTags(bundled);
  }
  try {
    const data = await fetchChangelog(lang, { force });
    if (!loadRequest.isCurrent(requestId)) return;
    releases.value = data.releases.length > 0 ? data.releases : getBundledChangelogReleases(lang);
    fromRemote.value = data.fromRemote ?? null;
    loadedLang.value = lang;
    visibleCount.value = PAGE_SIZE;
    seedExpandedTags(releases.value);
  } finally {
    if (loadRequest.isCurrent(requestId)) loading.value = false;
  }
}

onMounted(() => {
  void load();
});

watch(changelogLang, (lang) => {
  if (lang !== loadedLang.value) {
    expandedTags.value = new Set();
    void load();
  }
});
</script>

<template>
  <div class="rounded-lg border border-border/80 bg-muted/15" :class="compact ? 'p-3' : 'p-4'" data-release-notes-panel>
    <div v-if="showHeader" class="flex flex-wrap items-center justify-between gap-2 pb-2.5">
      <div class="flex min-w-0 items-center gap-2">
        <Sparkles class="h-3.5 w-3.5 shrink-0 text-primary" />
        <span class="text-xs font-semibold text-foreground">{{ t("updates.releaseNotesTitle") }}</span>
        <span v-if="fromRemote === false" class="truncate text-[11px] text-muted-foreground">{{ t("updates.offlineNotesHint") }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="openExternalUrl(changelogWebsiteUrl(changelogLang))">
          <ExternalLink class="mr-1 h-3 w-3" />
          {{ t("settings.changelogOpenWebsite") }}
        </Button>
        <Button type="button" variant="outline" size="icon" class="h-6 w-6" :disabled="loading" :title="t('settings.changelogRetry')" :aria-label="t('settings.changelogRetry')" @click="load(true)">
          <Loader2 v-if="loading" class="h-3 w-3 animate-spin" />
          <RefreshCw v-else class="h-3 w-3" />
        </Button>
      </div>
    </div>

    <div class="space-y-2" :class="compact ? 'max-h-56 overflow-y-auto pr-1' : ''">
      <div v-for="release in visibleReleases" :key="release.tag" class="overflow-hidden rounded-md border bg-background/80" :class="isLatestRelease(release.tag) ? 'border-primary/35' : 'border-border/70'">
        <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-expanded="isExpanded(release.tag)" @click="toggleRelease(release.tag)">
          <Badge variant="secondary" class="shrink-0 gap-1 font-mono text-[11px]">
            <Tag class="h-3 w-3" />
            {{ release.tag.replace(/^v/, "") }}
          </Badge>
          <span v-if="isLatestRelease(release.tag)" class="shrink-0 rounded-sm bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide text-primary-foreground">
            {{ t("settings.changelogNew") }}
          </span>
          <span v-if="isCurrentRelease(release.tag)" class="shrink-0 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-emerald-700 dark:text-emerald-300">
            {{ t("updates.currentVersionBadge") }}
          </span>
          <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {{ release.date ? t("settings.changelogPublishedOn", { date: formatReleaseDate(release.date) }) : release.name }}
          </span>
          <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform" :class="isExpanded(release.tag) ? 'rotate-180' : ''" />
        </button>

        <div v-if="isExpanded(release.tag)" class="border-t border-border/60 px-3 py-2.5 text-left">
          <template v-if="release.sections.length">
            <div v-for="(section, sectionIndex) in release.sections" :key="`${release.tag}-${section.type}-${sectionIndex}`" :class="sectionIndex > 0 ? 'mt-2.5' : ''">
              <div class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="sectionDotClass(section.type)" />
                <span>{{ sectionLabel(section.type, section.title) }}</span>
              </div>
              <ul class="space-y-1 pl-2.5">
                <li v-for="(item, itemIndex) in section.items" :key="itemIndex" class="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                  <span class="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                  <span>
                    <template v-if="item.desc">
                      <span class="font-medium text-foreground/90">{{ item.title }}</span> — {{ item.desc }}
                    </template>
                    <template v-else>{{ item.title }}</template>
                  </span>
                </li>
              </ul>
            </div>
          </template>
          <p v-else class="text-xs italic text-muted-foreground">{{ t("settings.changelogNoDetails") }}</p>

          <button type="button" class="mt-2.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline" @click.stop="openExternalUrl(changelogReleaseUrl(release.tag))">
            <ExternalLink class="h-3 w-3" />
            <span>{{ t("settings.changelogOpenGitHub") }}</span>
          </button>
        </div>
      </div>

      <Button v-if="hasMore" type="button" variant="outline" size="sm" class="h-7 w-full text-xs" @click="loadMore">
        {{ t("settings.changelogLoadMore") }}
      </Button>
    </div>
  </div>
</template>
