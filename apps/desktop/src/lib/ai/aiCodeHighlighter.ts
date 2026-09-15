import type { AppThemeAppearance } from "@/lib/app/appTheme";
import type { DynamicImportLanguageRegistration } from "shiki/core";

export type AiCodeHighlighter = (content: string, lang: string, appearance?: AppThemeAppearance) => string;

interface AiShikiCodeHighlighterOptions {
  appearance: () => AppThemeAppearance;
  /**
   * Called after a grammar outside `EAGER_SHIKI_LANGUAGES` finishes loading, with the language name
   * that became available. The caller re-renders so the block is highlighted instead of plain text.
   */
  onLanguageLoaded?: (lang: string) => void;
}

const SHIKI_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

/**
 * Grammars loaded together with the highlighter. A database answer is almost always SQL with shell,
 * JSON, YAML or XML snippets around it, so these cover the first message without a second request.
 */
const EAGER_SHIKI_LANGUAGES = ["bash", "json", "shellscript", "sql", "xml", "yaml"] as const;

/**
 * Grammars fetched the first time an answer actually uses them. They stay out of the boot path
 * because the large ones are expensive (`php` ~113KB, `typescript` ~181KB, `tsx` ~176KB).
 */
const DEFERRED_SHIKI_LANGUAGES = ["css", "go", "html", "java", "javascript", "markdown", "php", "python", "rust", "tsx", "typescript", "vue"] as const;

type ShikiLanguage = (typeof EAGER_SHIKI_LANGUAGES)[number] | (typeof DEFERRED_SHIKI_LANGUAGES)[number];

const SHIKI_LANGUAGE_LOADERS: Record<ShikiLanguage, DynamicImportLanguageRegistration> = {
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const SHIKI_LANG_BY_AI_LABEL: Record<string, ShikiLanguage | "text"> = {
  BASH: "bash",
  CLICKHOUSE: "sql",
  CSS: "css",
  GO: "go",
  HTML: "html",
  JAVA: "java",
  JAVASCRIPT: "javascript",
  JS: "javascript",
  JSON: "json",
  MARKDOWN: "markdown",
  MYSQL: "sql",
  PHP: "php",
  POSTGRESQL: "sql",
  PYTHON: "python",
  RUST: "rust",
  SHELL: "shellscript",
  SH: "shellscript",
  SQL: "sql",
  SQLITE: "sql",
  TS: "typescript",
  TSQL: "sql",
  TSX: "tsx",
  TYPESCRIPT: "typescript",
  VUE: "vue",
  XML: "xml",
  YAML: "yaml",
  YML: "yaml",
  ZSH: "shellscript",
};

type ShikiHighlighter = Awaited<ReturnType<typeof import("shiki/core").createHighlighterCore>>;

let highlighterPromise: Promise<ShikiHighlighter> | undefined;
const deferredLanguageLoads = new Map<ShikiLanguage, Promise<void>>();

export async function createAiShikiCodeHighlighter(options: AiShikiCodeHighlighterOptions): Promise<AiCodeHighlighter> {
  const highlighter = await getAiShikiHighlighter();
  return (content, lang, appearance = options.appearance()) => {
    const shikiLanguage = resolveShikiLanguage(lang);
    if (shikiLanguage === "text" || !isLanguageLoaded(highlighter, shikiLanguage)) {
      // The grammar only arrives asynchronously. Render this frame as escaped plain text, which is
      // byte-identical to the no-highlighter fallback, and re-render once the grammar lands.
      if (shikiLanguage !== "text") {
        void loadDeferredLanguage(highlighter, shikiLanguage, options.onLanguageLoaded);
      }
      return escapeHtml(content);
    }
    return highlighter.codeToHtml(content, {
      lang: shikiLanguage,
      structure: "inline",
      theme: SHIKI_THEMES[appearance],
    });
  };
}

function getAiShikiHighlighter(): Promise<ShikiHighlighter> {
  highlighterPromise ??= loadAiShikiHighlighter();
  return highlighterPromise;
}

async function loadAiShikiHighlighter(): Promise<ShikiHighlighter> {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight, ...eagerLanguages] = await Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
    ...EAGER_SHIKI_LANGUAGES.map((language) => SHIKI_LANGUAGE_LOADERS[language]()),
  ]);

  return createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: eagerLanguages.map((language) => language.default),
    themes: [githubDark.default, githubLight.default],
  });
}

/**
 * `getLoadedLanguages` also reports grammar aliases, so an alias such as `bash` is recognized as soon
 * as the grammar that declares it (`shellscript`) is in the registry.
 */
function isLanguageLoaded(highlighter: ShikiHighlighter, language: ShikiLanguage): boolean {
  return highlighter.getLoadedLanguages().includes(language);
}

function loadDeferredLanguage(highlighter: ShikiHighlighter, language: ShikiLanguage, onLoaded?: (lang: string) => void): Promise<void> {
  const pending = deferredLanguageLoads.get(language);
  if (pending) return pending;

  const load = SHIKI_LANGUAGE_LOADERS[language]()
    .then((grammar) => highlighter.loadLanguage(grammar.default))
    .then(() => {
      onLoaded?.(language);
    })
    .catch((error) => {
      // A failed grammar must stay a plain-text block instead of breaking the whole answer, and must
      // be retried on the next render rather than cached as a permanent failure.
      deferredLanguageLoads.delete(language);
      console.warn(`[ogdeveloper][aiCodeHighlighter] Failed to load grammar "${language}":`, error);
    });

  deferredLanguageLoads.set(language, load);
  return load;
}

function resolveShikiLanguage(lang: string): ShikiLanguage | "text" {
  return SHIKI_LANG_BY_AI_LABEL[lang.toUpperCase()] ?? "text";
}

function escapeHtml(content: string): string {
  return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
