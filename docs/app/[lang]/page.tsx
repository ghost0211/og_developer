import Link from "next/link";
import type { Metadata } from "next";
import { Spotlight } from "@/components/aceternity/Spotlight";
import { LandingNav } from "@/components/landing/LandingNav";
import { LandingFooter } from "@/components/landing/LandingFooter";
import { RevealSection } from "@/components/landing/RevealSection";
import { buildMetadata, getHtmlLang } from "@/lib/metadata";
import { buildSoftwareApplicationStructuredData } from "@/lib/structuredData";
import { ArrowRight, Bug, Database, FileCode, GitCompare, PlugZap, Search, Shield, Table, Terminal } from "lucide-react";

const APP_VERSION = "0.1.0";

const metrics = {
  en: [
    { value: "1", label: "database: openGauss, done right" },
    { value: "2", label: "connection modes (JDBC + native)" },
    { value: "10+", label: "A-compatibility types" },
    { value: "Apache-2.0", label: "fork of dbx, fully open source" },
  ],
  cn: [
    { value: "1", label: "种数据库：openGauss，做到极致" },
    { value: "2", label: "种连接模式（JDBC + 原生协议）" },
    { value: "10+", label: "个 A 兼容模式类型" },
    { value: "Apache-2.0", label: "基于 dbx 的 fork，完全开源" },
  ],
};

const workflows = {
  en: [
    {
      icon: PlugZap,
      title: "Connect to openGauss",
      desc: "Official JDBC driver with full SHA-256 support, or the native wire protocol with RAISE NOTICE capture.",
      href: "/en/docs/opengauss",
    },
    {
      icon: Terminal,
      title: "Write and run PL/SQL",
      desc: "PL/SQL-aware statement splitting, A-compatibility types, source reconstruction, and compile-error line mapping.",
      href: "/en/docs/plsql-development",
    },
    {
      icon: Bug,
      title: "Debug PL/SQL",
      desc: "Graphical debugger on dbe_pldebugger: breakpoints, stepping, variables, and the call stack.",
      href: "/en/docs/debugger",
    },
    {
      icon: Database,
      title: "Browse objects",
      desc: "Packages, synonyms, types, jobs, and invalid-object badges in the schema tree and object browser.",
      href: "/en/docs/schema-browser",
    },
  ],
  cn: [
    {
      icon: PlugZap,
      title: "连接 openGauss",
      desc: "官方 JDBC 驱动完整支持 SHA-256，原生协议带 RAISE NOTICE 捕获。",
      href: "/cn/docs/opengauss",
    },
    {
      icon: Terminal,
      title: "编写与执行 PL/SQL",
      desc: "PL/SQL 感知的语句切分、A 兼容类型、源码重建与编译错误行定位。",
      href: "/cn/docs/plsql-development",
    },
    {
      icon: Bug,
      title: "调试 PL/SQL",
      desc: "基于 dbe_pldebugger 的图形调试器：断点、单步、变量和调用栈。",
      href: "/cn/docs/debugger",
    },
    {
      icon: Database,
      title: "浏览对象",
      desc: "包、同义词、类型、作业和无效对象标记，尽在对象树与对象浏览器。",
      href: "/cn/docs/schema-browser",
    },
  ],
};

const capabilities = {
  en: [
    { icon: Database, label: "Bundled official openGauss JDBC driver (org.opengauss.Driver)" },
    { icon: Shield, label: "SHA-256 authentication supported out of the box" },
    { icon: Table, label: "DBMS_OUTPUT / RAISE NOTICE capture in the result view" },
    { icon: Search, label: "sql_compatibility (A/B/C/PG/M) awareness" },
    { icon: GitCompare, label: "Schema diff, ER diagrams, and data export for daily work" },
    { icon: FileCode, label: "Built on the DBX workbench: editor, grid, tunnels, and more" },
  ],
  cn: [
    { icon: Database, label: "内嵌官方 openGauss JDBC 驱动（org.opengauss.Driver）" },
    { icon: Shield, label: "开箱即用支持 SHA-256 认证" },
    { icon: Table, label: "结果视图捕获 DBMS_OUTPUT / RAISE NOTICE" },
    { icon: Search, label: "sql_compatibility（A/B/C/PG/M）模式感知" },
    { icon: GitCompare, label: "Schema 对比、ER 图与数据导出，覆盖日常开发" },
    { icon: FileCode, label: "基于 DBX 工作台：编辑器、数据网格、隧道等一应俱全" },
  ],
};

const i18nText = {
  en: {
    heroTitle: "openGauss 专用数据库开发工具",
    heroSubtitle: "One database, done right: PL/SQL splitting, A-compatibility types, a graphical debugger, and message capture — on top of the DBX workbench.",
    readDocs: "Read the docs",
    docsStart: "Start here",
    docsStartDesc: "Install og developer, create your first openGauss connection, and learn the main workflow.",
    workflowsTitle: "Core workflows",
    workflowsDesc: "The docs are organized around what you actually do with openGauss.",
    capabilitiesTitle: "Built for openGauss development",
    footerTitle: "Ready to try og developer?",
    footerDesc: "Browse the repository, read the docs, or build it from source. Installers will be published with the first release.",
    repo: "GitHub repository",
    forkNote: "og developer is a derivative fork of dbx (Apache-2.0). See the NOTICE file for the full list of modifications.",
  },
  cn: {
    heroTitle: "openGauss 专用数据库开发工具",
    heroSubtitle: "只做一种数据库，做到极致：PL/SQL 切分、A 兼容类型、图形调试器、消息捕获——构建在 DBX 工作台之上。",
    readDocs: "查看文档",
    docsStart: "从这里开始",
    docsStartDesc: "安装 og developer、创建第一个 openGauss 连接，并了解主要工作流。",
    workflowsTitle: "核心工作流",
    workflowsDesc: "文档围绕 openGauss 开发中的真实任务组织。",
    capabilitiesTitle: "为 openGauss 开发而生",
    footerTitle: "准备试试 og developer？",
    footerDesc: "浏览仓库、阅读文档或从源码构建。安装包将随首个版本发布。",
    repo: "GitHub 仓库",
    forkNote: "og developer 是 dbx（Apache-2.0）的派生 fork，修改清单见 NOTICE 文件。",
  },
};

const landingMeta = {
  en: {
    title: "og developer — 一个为 openGauss 而生的数据库开发工具",
    description: "An openGauss-specific database development tool: PL/SQL splitting, A-compatibility types, graphical debugger, and message capture, on top of the DBX workbench.",
  },
  cn: {
    title: "og developer — openGauss 专用数据库开发工具",
    description: "openGauss 专用数据库开发工具：PL/SQL 切分、A 兼容类型、图形调试器与消息捕获，构建在 DBX 工作台之上。",
  },
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const meta = landingMeta[l];

  return buildMetadata({
    title: meta.title,
    description: meta.description,
    path: `/${l}`,
    lang: l,
    ogType: "website",
  });
}

export default async function LandingPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const l = lang === "cn" ? "cn" : "en";
  const t = i18nText[l];
  const workflowItems = workflows[l];
  const capabilityItems = capabilities[l];
  const metricItems = metrics[l];
  const softwareStructuredData = buildSoftwareApplicationStructuredData(l, APP_VERSION);

  return (
    <main className="landing" lang={getHtmlLang(l)}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareStructuredData) }} />
      {/* Nav */}
      <LandingNav lang={l} active="home" />

      {/* Hero */}
      <section className="landing-hero" aria-labelledby="landing-title">
        <Spotlight />
        <div className="relative z-[1] max-w-[1180px] mx-auto px-7 max-[1040px]:max-w-[920px] max-[760px]:px-[18px]">
          <div className="landing-hero-copy relative z-[6] grid justify-items-center max-w-[900px] mx-auto text-center max-[1040px]:max-w-[760px]">
            <h1 id="landing-title" className="min-w-0 m-0 text-[clamp(36px,4.2vw,56px)] font-[820] leading-[1.06] text-landing-ink max-[760px]:max-w-[12ch] max-[760px]:text-[clamp(29px,8.7vw,38px)] max-[760px]:leading-[1.08] max-[760px]:text-balance">{t.heroTitle}</h1>
            <p className="landing-hero-subtitle min-w-0 mt-5 mx-auto text-[17px] font-[460] leading-[1.8] max-[900px]:max-w-[680px] max-[760px]:max-w-[320px] max-[760px]:text-[15px] max-[760px]:leading-[1.68]">{t.heroSubtitle}</p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3 max-[760px]:mt-7">
              <Link href={`/${l}/docs/getting-started`} className="landing-inline-link inline-flex items-center gap-[7px] rounded-[7px] px-5 py-2.5 text-sm font-[650]">
                {t.readDocs}
                <ArrowRight size={15} />
              </Link>
              <a href="https://github.com/ghost0211/og_developer" target="_blank" rel="noopener noreferrer" className="landing-inline-link inline-flex items-center gap-[7px] rounded-[7px] px-5 py-2.5 text-sm font-[650] opacity-80 hover:opacity-100">
                {t.repo}
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Metrics */}
      <RevealSection className="grid grid-cols-4 gap-3 max-w-[1180px] mx-auto px-7 pt-6 pb-11 max-[760px]:grid-cols-2 max-[760px]:gap-2.5 max-[760px]:px-[18px] max-[760px]:pb-7" aria-label={l === "cn" ? "og developer 核心指标" : "og developer key metrics"}>
        {metricItems.map((item) => (
          <div key={item.label} data-stagger className="landing-glass-card min-h-[118px] rounded-[10px] p-[22px] max-[760px]:min-h-[88px] max-[760px]:p-4">
            <strong className="block text-landing-ink text-2xl font-[720]">{item.value}</strong>
            <span className="block mt-1 text-landing-muted text-[13px]">{item.label}</span>
          </div>
        ))}
      </RevealSection>

      {/* Doc start */}
      <RevealSection className="landing-glass-card-green flex items-center justify-between gap-[22px] max-w-[calc(1180px-56px)] mx-auto px-7 py-7 rounded-[10px] max-[760px]:block max-[760px]:mx-[18px] max-[760px]:px-[18px] max-[760px]:py-5">
        <div>
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.docsStart}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.docsStartDesc}</p>
        </div>
        <Link href={`/${l}/docs/getting-started`} className="landing-inline-link flex shrink-0 items-center gap-[7px] text-sm font-[650] max-[760px]:mt-4" target="_blank">
          {t.readDocs}
          <ArrowRight size={15} />
        </Link>
      </RevealSection>

      {/* Workflows */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 max-[760px]:px-[18px]">
        <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.workflowsTitle}</h2>
          <p className="mt-2 max-w-[650px] text-landing-muted text-sm leading-[1.65] justify-self-end text-right max-[760px]:max-w-none max-[760px]:text-left">{t.workflowsDesc}</p>
        </div>
        <div className="landing-workflow-grid grid grid-cols-4 rounded-[10px] overflow-hidden max-[1040px]:grid-cols-2 max-[760px]:grid-cols-2 max-[360px]:grid-cols-1">
          {workflowItems.map((item, i) => (
            <Link
              key={item.title}
              href={item.href}
              className={`landing-workflow-card min-h-[250px] p-6 border-r border-r-landing-line max-[760px]:min-h-0 max-[760px]:p-[18px] ${i === workflowItems.length - 1 ? "border-r-0" : ""}`}
              target="_blank"
              data-stagger
            >
              <item.icon size={20} className="text-landing-blue" />
              <h3 className="mt-[18px] text-base font-bold">{item.title}</h3>
              <p className="mt-2.5 text-landing-muted text-[13px] leading-[1.62]">{item.desc}</p>
              <span className="inline-flex items-center gap-1.5 mt-[18px] text-landing-ink text-[13px] font-[650]">
                {t.readDocs}
                <ArrowRight size={14} />
              </span>
            </Link>
          ))}
        </div>
      </RevealSection>

      {/* Capabilities */}
      <RevealSection className="max-w-[1180px] mx-auto px-7 pt-[70px] pb-1 max-[760px]:px-[18px]">
        <div className="grid grid-cols-[minmax(220px,0.42fr)_minmax(0,0.58fr)] gap-9 items-end mb-[22px] max-[760px]:block">
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.capabilitiesTitle}</h2>
        </div>
        <div className="grid grid-cols-3 gap-2.5 max-[1040px]:grid-cols-2 max-[760px]:grid-cols-2 max-[760px]:mt-[18px] max-[360px]:grid-cols-1">
          {capabilityItems.map((item) => (
            <div key={item.label} className="landing-capability flex items-center gap-2.5 min-h-[72px] rounded-lg px-[15px] py-3.5 max-[760px]:min-h-[62px] max-[760px]:px-3" data-stagger>
              <item.icon size={18} className="shrink-0 text-landing-blue" />
              <span className="text-landing-ink text-[13px] font-[560] leading-[1.45]">{item.label}</span>
            </div>
          ))}
        </div>
      </RevealSection>

      {/* Final CTA */}
      <RevealSection className="flex items-center justify-between gap-6 max-w-[1180px] mx-auto px-7 border border-landing-line rounded-[10px] bg-landing-panel mt-[72px] mb-6 py-[30px] max-[760px]:block max-[760px]:px-[18px]">
        <div>
          <h2 className="m-0 text-[25px] font-[720] text-landing-ink">{t.footerTitle}</h2>
          <p className="mt-2 text-landing-muted text-sm leading-[1.65]">{t.footerDesc}</p>
          <p className="mt-3 text-[12px] text-landing-muted leading-[1.6]">{t.forkNote}</p>
        </div>
        <div className="flex items-center gap-2.5 flex-wrap justify-end max-[760px]:mt-[18px]">
          <a href="https://github.com/ghost0211/og_developer" target="_blank" rel="noopener noreferrer" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-[15px] text-sm font-[650]">
            {t.repo}
          </a>
          <Link href={`/${l}/docs/getting-started`} target="_blank" className="landing-final-link inline-flex items-center justify-center min-h-[42px] rounded-[7px] px-[15px] text-sm font-[650]">
            {t.readDocs}
          </Link>
        </div>
      </RevealSection>

      <LandingFooter lang={l} />
    </main>
  );
}
