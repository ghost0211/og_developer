import { getBundledChangelogReleases } from "@/lib/app/releaseNotesData";

export type ChangelogItem = {
  title: string;
  desc: string;
};

export type ChangelogSection = {
  type: string;
  title: string;
  items: ChangelogItem[];
};

export type ChangelogRelease = {
  tag: string;
  name: string;
  date: string;
  sections: ChangelogSection[];
};

export type ChangelogData = {
  updatedAt: string;
  releases: ChangelogRelease[];
  fromRemote?: boolean;
};

export type ChangelogLang = "en" | "cn";

const GITHUB_RELEASES_PAGE = "https://github.com/ghost0211/og_developer/releases";
const cache = new Map<ChangelogLang, Promise<ChangelogData>>();

export { getBundledChangelogReleases };

export function createLatestRequestGuard() {
  let latestRequestId = 0;
  return {
    begin: () => ++latestRequestId,
    isCurrent: (requestId: number) => requestId === latestRequestId,
  };
}

export function changelogLangFromLocale(locale: string): ChangelogLang {
  return locale.toLowerCase().startsWith("zh") ? "cn" : "en";
}

export function changelogWebsiteUrl(_lang?: ChangelogLang): string {
  return GITHUB_RELEASES_PAGE;
}

export function changelogReleaseUrl(tag: string): string {
  const normalized = tag.trim().startsWith("v") ? tag.trim() : `v${tag.trim()}`;
  return `${GITHUB_RELEASES_PAGE}/tag/${encodeURIComponent(normalized)}`;
}

function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function parseVersionParts(tag: string): number[] {
  return normalizeTag(tag)
    .slice(1)
    .split(/[.\-+]/)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

export function compareReleaseTagDesc(a: string, b: string): number {
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i += 1) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numB - numA;
  }
  return normalizeTag(b).localeCompare(normalizeTag(a));
}

export function mergeChangelogReleases(remote: ChangelogRelease[], bundled: ChangelogRelease[]): ChangelogRelease[] {
  const byTag = new Map<string, ChangelogRelease>();

  for (const item of remote) {
    if (!item || typeof item.tag !== "string" || !item.tag.trim()) continue;
    const tag = normalizeTag(item.tag);
    byTag.set(tag, {
      ...item,
      tag,
      sections: Array.isArray(item.sections) ? item.sections : [],
    });
  }

  for (const item of bundled) {
    const tag = normalizeTag(item.tag);
    const existing = byTag.get(tag);
    byTag.set(tag, {
      ...item,
      tag,
      date: item.date || existing?.date || "",
      name: item.name || existing?.name || `OG Developer ${tag}`,
    });
  }

  return Array.from(byTag.values()).sort((a, b) => compareReleaseTagDesc(a.tag, b.tag));
}

export async function fetchChangelog(lang: ChangelogLang, options: { force?: boolean } = {}): Promise<ChangelogData> {
  if (options.force) {
    cache.delete(lang);
  }

  let pending = cache.get(lang);
  if (!pending) {
    pending = loadChangelog(lang);
    cache.set(lang, pending);
  }

  return pending;
}

async function loadChangelog(lang: ChangelogLang): Promise<ChangelogData> {
  const bundled = getBundledChangelogReleases(lang);
  try {
    const { fetchChangelog: fetchChangelogViaBackend } = await import("@/lib/backend/api");
    const data = await fetchChangelogViaBackend(lang);
    const remoteReleases = Array.isArray(data?.releases) ? data.releases.filter((release) => release && typeof release.tag === "string") : [];
    const merged = mergeChangelogReleases(remoteReleases, bundled);
    return {
      updatedAt: typeof data?.updatedAt === "string" && data.updatedAt ? data.updatedAt : merged[0]?.date || "",
      releases: merged,
      fromRemote: true,
    };
  } catch {
    return {
      updatedAt: bundled[0]?.date || "",
      releases: bundled,
      fromRemote: false,
    };
  }
}
