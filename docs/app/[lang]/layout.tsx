import "../global.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { StaticSearchDialog } from "@/components/StaticSearchDialog";
import { i18nUI } from "@/lib/i18n";
import { buildMetadata, DEFAULT_DESCRIPTION, getHtmlLang, SITE_NAME, SITE_URL } from "@/lib/metadata";
import { buildSiteStructuredData } from "@/lib/structuredData";

const LOCALE_MAP: Record<string, { locale: string; title: string; description: string }> = {
  en: {
    locale: "en_US",
    title: "og developer — an openGauss-specific database development tool",
    description: DEFAULT_DESCRIPTION,
  },
  cn: {
    locale: "zh_CN",
    title: "og developer — openGauss 专用数据库开发工具",
    description: "openGauss 专用数据库开发工具：官方 JDBC 驱动内嵌、PL/SQL 调试器、DBMS_OUTPUT / RAISE NOTICE 捕获、包/同义词对象树。基于 dbx（Apache-2.0）的深度定制 fork。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const meta = LOCALE_MAP[l];

  const pageMetadata = buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}`,
    lang: l,
  });

  return {
    ...pageMetadata,
    title: {
      default: meta.title,
      template: `%s | ${SITE_NAME}`,
    },
    metadataBase: new URL(SITE_URL),
    icons: {
      icon: "/favicon.png",
      shortcut: "/favicon.png",
      apple: "/logo.png",
    },
    robots: { index: true, follow: true },
    openGraph: { ...pageMetadata.openGraph, locale: meta.locale },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b1120",
  colorScheme: "dark light",
};

export default async function LangLayout({ params, children }: { params: Promise<{ lang: string }>; children: ReactNode }) {
  const { lang } = await params;
  const locale = lang === "cn" ? "cn" : "en";
  const siteStructuredData = buildSiteStructuredData();

  return (
    <html lang={getHtmlLang(locale)} suppressHydrationWarning>
      <head>
        {siteStructuredData.map((structuredData) => (
          <script key={structuredData["@id"]} type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
        ))}
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          i18n={i18nUI.provider(locale)}
          search={{
            SearchDialog: StaticSearchDialog,
          }}
          theme={{ defaultTheme: "system", enableSystem: true }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}

export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "cn" }];
}
