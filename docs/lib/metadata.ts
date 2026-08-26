import type { Metadata } from "next";

export const SITE_URL = "https://github.com/ghost0211/og_developer";
export const SITE_NAME = "OG Developer";
export const DEFAULT_DESCRIPTION = "openGauss 专用数据库开发工具：官方 JDBC 驱动内嵌、PL/SQL 调试器、DBMS_OUTPUT / RAISE NOTICE 捕获、包/同义词对象树。基于 dbx（Apache-2.0）的深度定制 fork。";
export const DEFAULT_DESCRIPTION_EN = "An openGauss-specific database development tool: bundled official JDBC driver, PL/SQL debugger, DBMS_OUTPUT / RAISE NOTICE capture, and package/synonym object tree. A deep-customized fork of dbx (Apache-2.0).";
export const DEFAULT_OG_IMAGE = "/logo.png";

const LOCALE_MAP: Record<string, string> = {
  en: "en_US",
  cn: "zh_CN",
};

const HTML_LANG_MAP: Record<string, string> = {
  en: "en",
  cn: "zh-CN",
};

export function getHtmlLang(lang: string): string {
  return HTML_LANG_MAP[lang] ?? "en";
}

function swapLang(path: string, to: string): string {
  return path.replace(/^\/(en|cn)/, `/${to}`);
}

interface BuildMetadataParams {
  title: string;
  description: string;
  path: string;
  lang: string;
}

export function buildMetadata({ title, description, path, lang, ogType }: BuildMetadataParams & { ogType?: "website" | "article" }): Metadata {
  const htmlLang = HTML_LANG_MAP[lang] ?? "en";
  const url = `${SITE_URL}${path}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
      languages: {
        en: `${SITE_URL}${swapLang(path, "en")}`,
        zh: `${SITE_URL}${swapLang(path, "cn")}`,
      },
    },
    openGraph: {
      title,
      description,
      url,
      type: ogType ?? "website",
      locale: LOCALE_MAP[lang] ?? "en_US",
      siteName: SITE_NAME,
      images: [{ url: DEFAULT_OG_IMAGE }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [DEFAULT_OG_IMAGE],
    },
  };
}
