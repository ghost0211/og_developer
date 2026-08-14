import { DEFAULT_DESCRIPTION, SITE_NAME, SITE_URL } from "./metadata";

const localizedDescription = {
  en: "An openGauss-specific database development tool, a deep-customized fork of dbx (Apache-2.0): official JDBC driver, PL/SQL debugger, DBMS_OUTPUT / RAISE NOTICE capture, and package/synonym object tree.",
  cn: DEFAULT_DESCRIPTION,
} as const;

const localizedFeatureList = {
  en: [
    "Bundled official openGauss JDBC driver with full SHA-256 support",
    "PL/SQL-aware statement splitting and A-compatibility types",
    "Graphical PL/SQL debugger based on dbe_pldebugger",
    "DBMS_OUTPUT / RAISE NOTICE capture through JDBC and native wire protocol",
    "Package, synonym, type, and job object tree with invalid-object badges",
    "sql_compatibility (A/B/C/PG/M) awareness",
  ],
  cn: [
    "内嵌官方 openGauss JDBC 驱动，完整支持 SHA-256 认证",
    "PL/SQL 感知的语句切分与 A 兼容模式类型",
    "基于 dbe_pldebugger 的图形化 PL/SQL 调试器",
    "JDBC 与原生协议双路捕获 DBMS_OUTPUT / RAISE NOTICE",
    "包、同义词、类型、作业对象树，含无效对象标记",
    "sql_compatibility（A/B/C/PG/M）兼容模式感知",
  ],
} as const;

const REPO_URL = "https://github.com/ghost0211/og_developer";
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export function buildSiteStructuredData() {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      inLanguage: ["en", "zh-CN"],
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      url: SITE_URL,
      description: DEFAULT_DESCRIPTION,
      logo: `${SITE_URL}/logo.png`,
      sameAs: [REPO_URL],
    },
  ] as const;
}

export function buildSoftwareApplicationStructuredData(lang: "en" | "cn", version: string) {
  const language = lang === "cn" ? "zh-CN" : "en";

  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${SITE_URL}/#software`,
    name: SITE_NAME,
    url: `${SITE_URL}/${lang}`,
    description: localizedDescription[lang],
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: "Database management",
    operatingSystem: "Windows, macOS, Linux",
    softwareVersion: version,
    isAccessibleForFree: true,
    inLanguage: language,
    codeRepository: REPO_URL,
    downloadUrl: `${REPO_URL}/releases/latest`,
    license: LICENSE_URL,
    featureList: [...localizedFeatureList[lang]],
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    sameAs: [REPO_URL],
  } as const;
}
