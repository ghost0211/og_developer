import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./i18n-autofill.mjs", import.meta.url));
const originalEnglish = 'export default {\n  common: {\n    existing: "Keep this translation",\n  },\n};\n';

function chineseSource(includeNewKey) {
  return [
    'import { withEnglishFallback } from "./fallback";',
    'export default withEnglishFallback({',
    '  common: {',
    '    existing: "已有内容",',
    ...(includeNewKey ? ['    greeting: "你好 {name}",'] : []),
    '  },',
    '});',
    '',
  ].join("\n");
}

function fixture(t) {
  const tempRoot = resolve(tmpdir());
  const root = mkdtempSync(join(tempRoot, "og-i18n-autofill-"));
  t.after(() => {
    if (dirname(root) !== tempRoot || !basename(root).startsWith("og-i18n-autofill-")) {
      throw new Error("Refusing to remove a path outside the test fixture directory");
    }
    rmSync(root, { recursive: true, force: true });
  });
  const localeDir = join(root, "apps/desktop/src/i18n/locales");
  mkdirSync(localeDir, { recursive: true });
  writeFileSync(join(localeDir, "zh-CN.ts"), chineseSource(false));
  writeFileSync(join(localeDir, "en.ts"), originalEnglish);
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "--quiet");
  git("add", "apps");
  git("-c", "user.name=I18n Test", "-c", "user.email=i18n-test@example.invalid", "commit", "--no-gpg-sign", "--quiet", "-m", "fixture baseline");
  writeFileSync(join(localeDir, "zh-CN.ts"), chineseSource(true));
  return { root, localeDir };
}

function run(root, mode) {
  const summaryPath = join(root, "summary.json");
  const result = spawnSync(process.execPath, [script, "--base-ref", "HEAD", "--mock-translations", mode], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEEPSEEK_API_KEY: "", I18N_SUMMARY_FILE: summaryPath },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(readFileSync(summaryPath, "utf8"));
}

test("new Chinese keys are filled in English with only the two supported locale files", (t) => {
  const { root, localeDir } = fixture(t);
  const summary = run(root, "--write");
  const english = readFileSync(join(localeDir, "en.ts"), "utf8");
  assert.match(english, /greeting: "\[en\] 你好 \{name\}"/);
  assert.match(english, /existing: "Keep this translation"/);
  assert.equal(readFileSync(join(localeDir, "zh-CN.ts"), "utf8"), chineseSource(true));
  assert.deepEqual(readdirSync(localeDir).sort(), ["en.ts", "zh-CN.ts"]);
  assert.deepEqual(summary.updatedLocales, [{ locale: "en", count: 1 }]);
});

test("dry run accepts a bilingual repository without changing either locale", (t) => {
  const { root, localeDir } = fixture(t);
  const summary = run(root, "--dry-run");
  assert.equal(readFileSync(join(localeDir, "en.ts"), "utf8"), originalEnglish);
  assert.equal(readFileSync(join(localeDir, "zh-CN.ts"), "utf8"), chineseSource(true));
  assert.deepEqual(readdirSync(localeDir).sort(), ["en.ts", "zh-CN.ts"]);
  assert.deepEqual(summary.updatedLocales, [{ locale: "en", count: 1 }]);
});
