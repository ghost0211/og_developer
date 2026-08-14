"use client";

import Link from "next/link";
import { Github, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const i18n = {
  en: {
    home: "Home",
    docs: "Docs",
    langLabel: "切换到中文",
    menu: "Open navigation",
    closeMenu: "Close navigation",
  },
  cn: {
    home: "首页",
    docs: "文档",
    langLabel: "Switch to English",
    menu: "打开导航",
    closeMenu: "关闭导航",
  },
};

const REPO_URL = "https://github.com/ghost0211/og_developer";

export function LandingNav({ lang, active }: { lang: "en" | "cn"; active?: "home" | "docs" }) {
  const ref = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const t = i18n[lang];
  const otherLang = lang === "cn" ? "en" : "cn";
  const langHref = `/${otherLang}${active === "docs" ? "/docs/getting-started" : ""}`;
  const navItems = [
    { id: "home", href: `/${lang}`, label: t.home, tabletHidden: false },
    { id: "docs", href: `/${lang}/docs/getting-started`, label: t.docs, tabletHidden: false },
  ] as const;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    function onScroll() {
      node!.classList.toggle("is-scrolled", window.scrollY > 60);
    }

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const closeOnDesktop = () => {
      if (window.innerWidth > 760) setMenuOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnDesktop);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnDesktop);
    };
  }, [menuOpen]);

  return (
    <nav ref={ref} className={`landing-nav${menuOpen ? " is-menu-open" : ""}`} aria-label={lang === "cn" ? "主导航" : "Primary navigation"}>
      <div className="landing-nav-inner flex items-center justify-between max-w-[1180px] h-16 mx-auto px-7 max-[760px]:min-h-[60px] max-[760px]:h-auto max-[760px]:px-[18px] max-[760px]:py-2">
        <Link href={`/${lang}`} className="landing-nav-brand flex min-h-11 items-center gap-2.5 text-landing-ink text-2xl font-[820]" onClick={() => setMenuOpen(false)}>
          <img src="/logo.png" alt="" aria-hidden="true" width={28} height={28} />
          <span>og developer</span>
        </Link>
        <div className="flex items-center gap-1">
          {navItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              className={`landing-nav-link inline-flex h-9 items-center rounded-[7px] px-[10px] text-[13px] font-medium max-[760px]:hidden ${item.tabletHidden ? "max-[900px]:hidden" : ""} ${active === item.id ? "text-landing-ink" : "text-landing-muted"}`}
            >
              {item.label}
            </Link>
          ))}
          <Link href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub" title="GitHub" className="landing-nav-link inline-flex size-9 items-center justify-center rounded-[7px] text-landing-muted max-[760px]:hidden">
            <Github size={18} strokeWidth={2} />
          </Link>
          <Link href={langHref} aria-label={t.langLabel} title={t.langLabel} className="landing-nav-link ml-1.5 inline-flex h-9 items-center justify-center rounded-[7px] border border-landing-line px-3 text-[12px] font-[650] tracking-tight text-landing-muted" onClick={() => setMenuOpen(false)}>
            文/A
          </Link>
          <button
            type="button"
            className="landing-nav-link ml-1 inline-flex size-11 items-center justify-center rounded-[7px] border border-landing-line text-landing-ink min-[761px]:hidden"
            aria-controls="landing-mobile-menu"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? t.closeMenu : t.menu}
            onClick={() => setMenuOpen((current) => !current)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
      <div id="landing-mobile-menu" className="landing-mobile-menu min-[761px]:hidden" data-open={menuOpen} aria-hidden={!menuOpen}>
        <button type="button" className="landing-mobile-menu-backdrop" aria-label={t.closeMenu} tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)} />
        <div className="landing-mobile-menu-panel">
          {navItems.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              className="landing-mobile-menu-link"
              onClick={() => setMenuOpen(false)}
              tabIndex={menuOpen ? 0 : -1}
            >
              <span>{item.label}</span>
              <span aria-hidden="true">→</span>
            </Link>
          ))}
          <Link href={REPO_URL} target="_blank" rel="noopener noreferrer" className="landing-mobile-menu-link" onClick={() => setMenuOpen(false)} tabIndex={menuOpen ? 0 : -1}>
            <span className="inline-flex items-center gap-2"><Github size={17} /> GitHub</span>
            <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </div>
    </nav>
  );
}
