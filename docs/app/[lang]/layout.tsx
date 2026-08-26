import "../global.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { RootProvider } from "fumadocs-ui/provider/next";
import { StaticSearchDialog } from "@/components/StaticSearchDialog";
import { i18nUI } from "@/lib/i18n";
import { buildMetadata, DEFAULT_DESCRIPTION, DEFAULT_DESCRIPTION_EN, getHtmlLang, SITE_NAME, SITE_URL } from "@/lib/metadata";
import { buildSiteStructuredData } from "@/lib/structuredData";

const LOCALE_MAP: Record<string, { locale: string; title: string; description: string }> = {
  en: {
    locale: "en_US",
    title: "OG Developer — an openGauss-specific database development tool",
    description: DEFAULT_DESCRIPTION_EN,
  },
  cn: {
    locale: "zh_CN",
    title: "OG Developer — openGauss 专用数据库开发工具",
    description: DEFAULT_DESCRIPTION,
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
  const siteStructuredData = buildSiteStructuredData(locale);

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
