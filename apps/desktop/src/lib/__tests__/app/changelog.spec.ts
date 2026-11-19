import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { changelogLangFromLocale, changelogReleaseUrl, changelogWebsiteUrl, compareReleaseTagDesc, fetchChangelog, getBundledChangelogReleases, mergeChangelogReleases } from "@/lib/app/changelog";

vi.mock("@/lib/backend/api", () => ({
  fetchChangelog: vi.fn(),
}));

describe("changelog & release notes helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("points website and release URLs to the og_developer GitHub repository", () => {
    expect(changelogWebsiteUrl("cn")).toBe("https://github.com/ghost0211/og_developer/releases");
    expect(changelogWebsiteUrl("en")).toBe("https://github.com/ghost0211/og_developer/releases");
    expect(changelogReleaseUrl("0.3.3")).toBe("https://github.com/ghost0211/og_developer/releases/tag/v0.3.3");
    expect(changelogReleaseUrl("v0.3.3")).toBe("https://github.com/ghost0211/og_developer/releases/tag/v0.3.3");
    expect(changelogLangFromLocale("zh-CN")).toBe("cn");
    expect(changelogLangFromLocale("en-US")).toBe("en");
  });

  it("includes curated bilingual bundled releases starting at v0.3.3", () => {
    const cn = getBundledChangelogReleases("cn");
    const en = getBundledChangelogReleases("en");
    expect(cn[0]?.tag).toBe("v0.3.3");
    expect(en[0]?.tag).toBe("v0.3.3");
    expect(cn.length).toBeGreaterThanOrEqual(8);
    expect(en.length).toBe(cn.length);
  });

  it("merges future remote releases ahead of bundled entries in descending version order", () => {
    const bundled = getBundledChangelogReleases("en");
    const merged = mergeChangelogReleases(
      [
        {
          tag: "0.3.4",
          name: "OG Developer v0.3.4",
          date: "2026-11-25",
          sections: [{ type: "added", title: "Added", items: [{ title: "Online Feature", desc: "Fetched remotely" }] }],
        },
        {
          tag: "v0.3.3",
          name: "Remote placeholder",
          date: "2026-11-20",
          sections: [],
        },
      ],
      bundled,
    );

    expect(merged[0]?.tag).toBe("v0.3.4");
    expect(merged[1]?.tag).toBe("v0.3.3");
    expect(merged[1]?.sections.length).toBeGreaterThan(0);
    expect(compareReleaseTagDesc("v0.3.10", "v0.3.3")).toBeLessThan(0);
  });

  it("falls back cleanly to bundled releases when remote fetch fails", async () => {
    vi.mocked(api.fetchChangelog).mockRejectedValueOnce(new Error("offline"));
    const result = await fetchChangelog("cn", { force: true });

    expect(result.fromRemote).toBe(false);
    expect(result.releases[0]?.tag).toBe("v0.3.3");
  });

  it("merges remote releases when backend succeeds", async () => {
    vi.mocked(api.fetchChangelog).mockResolvedValueOnce({
      updatedAt: "2026-11-26",
      releases: [
        {
          tag: "v0.4.0",
          name: "OG Developer v0.4.0",
          date: "2026-11-26",
          sections: [{ type: "added", title: "Added", items: [{ title: "Major update", desc: "Remote release" }] }],
        },
      ],
    });
    const result = await fetchChangelog("en", { force: true });

    expect(result.fromRemote).toBe(true);
    expect(result.releases[0]?.tag).toBe("v0.4.0");
    expect(result.releases.some((item) => item.tag === "v0.3.3")).toBe(true);
  });
});
