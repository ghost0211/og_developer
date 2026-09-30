// Real Chromium layout regression without opening a window or using a user's profile.
// Tests the SFC's actual composer CSS and button class lists in an isolated fixture.
// This is a layout test, not a mounted-app interaction test.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const browser =
  process.env.OGDEVELOPER_TEST_CHROME || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
assert.ok(browser && existsSync(browser), "Set OGDEVELOPER_TEST_CHROME to a Chrome/Edge/Chromium executable");
const source = await readFile(new URL("../apps/desktop/src/components/editor/AiAssistant.vue", import.meta.url), "utf8");
const css = source.match(/<style scoped>([\s\S]*?)\.ai-markdown/)[1];
const classLists = [...source.matchAll(/class="([^"]+)"/g)].map((match) => match[1]);
const classes = Object.fromEntries(
  ["ai-composer-controls", "ai-composer-toolbar", "ai-composer-mode", "ai-composer-model-controls", "ai-composer-model", "ai-composer-effort", "ai-composer-submit"].map((name) => {
    const value = classLists.find((list) => list.split(/\s+/).includes(name));
    assert.ok(value, `Missing ${name}`);
    return [name, value];
  }),
);
const work = await mkdtemp(join(tmpdir(), "ogdeveloper-composer-layout-"));
try {
  const html = `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing: border-box; } body { margin: 0; font: 11px Arial, sans-serif; }
    button { font: inherit; background: white; line-height: 1.5; }
    .flex { display: flex; } .items-center { align-items: center; }
    .justify-center { justify-content: center; } .gap-1 { gap: 4px; } .gap-1\\.5 { gap: 6px; }
    .min-w-0 { min-width: 0; } .w-full { width: 100%; } .flex-1 { flex: 1 1 0%; }
    .shrink-0 { flex-shrink: 0; } .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .text-left { text-align: left; } .border { border: 1px solid #aaa; }
    .px-2 { padding-left: 8px; padding-right: 8px; } .py-0\\.5 { padding-top: 2px; padding-bottom: 2px; }
    .h-3 { height: 12px; } .w-3 { width: 12px; } .h-7 { height: 28px; } .w-7 { width: 28px; }
    ${css}
  </style><main id="fixture"></main><pre id="result"></pre><script>
    const classes = ${JSON.stringify(classes)};
    const failures = [], snapshots = new Map();
    let cases = 0;
    function check(value, message) { if (!value) failures.push(message); }
    const icon = '<span class="h-3 w-3 shrink-0" data-icon></span>';
    const arrow = '<span class="h-3 w-3 shrink-0" data-arrow></span>';
    for (const width of [180, 240, 280, 299, 300, 360, 420, 480, 519, 520, 600, 800]) {
      for (const locale of ['zh', 'en']) {
        for (const state of ['both', 'model-only', 'no-model']) {
          for (const model of ['k3', 'kimi-for-coding-highspeed', 'antigravity/claude-opus-4-6-thinking-with-a-very-long-custom-model-name']) {
            for (const effortValue of (state === 'both' ? ['M', locale === 'zh' ? '配置默认' : 'Provider default', 'persistent-custom-reasoning-effort-with-an-extra-long-name'] : [''])) {
            const fixture = document.getElementById('fixture');
            fixture.style.width = width + 'px';
            const mode = locale === 'zh' ? 'Ask · 通用问答' : 'Agent · Analyze execution plan and optimize';
            const effort = (locale === 'zh' ? '思考等级 ' : 'Thinking ') + effortValue;
            const selectors = state === 'no-model' ? '' : '<div class="' + classes['ai-composer-model-controls'] + (state === 'both' ? ' ai-composer-model-controls--with-effort' : '') + '">' +
              '<button class="' + classes['ai-composer-model'] + '">' + icon + '<span class="min-w-0 flex-1 truncate text-left" data-label>' + model + '</span>' + arrow + '</button>' +
              (state === 'both' ? '<button class="' + classes['ai-composer-effort'] + '"><span class="min-w-0 flex-1 truncate text-left" data-label>' + effort + '</span>' + arrow + '</button>' : '') + '</div>';
            fixture.innerHTML = '<div class="' + classes['ai-composer-controls'] + '"><div class="' + classes['ai-composer-toolbar'] + (state !== 'no-model' ? ' ai-composer-toolbar--with-models' : '') + '">' +
              '<button class="' + classes['ai-composer-mode'] + '">' + icon + '<span class="min-w-0 truncate" data-label>' + mode + '</span>' + arrow + '</button>' + selectors +
              '<button class="' + classes['ai-composer-submit'] + '"></button></div></div>';
            const tag = width + '/' + locale + '/' + state + '/' + model + '/' + effortValue;
            const toolbar = fixture.querySelector('.ai-composer-toolbar');
            check(toolbar.scrollWidth <= width + 1, tag + ': toolbar overflow');
            const buttons = [...fixture.querySelectorAll('button')];
            for (const button of buttons) {
              const rect = button.getBoundingClientRect();
              check(rect.left >= -0.5 && rect.right <= width + 0.5, tag + ': button outside container');
              for (const child of button.querySelectorAll('[data-icon], [data-arrow], [data-label]')) {
                const inner = child.getBoundingClientRect();
                check(inner.left >= rect.left && inner.right <= rect.right + 0.5, tag + ': icon/arrow/label clipped');
                check(inner.width >= (child.hasAttribute('data-label') ? 40 : 12) - 0.5, tag + ': collapsed icon/label');
              }
            }
            const submit = fixture.querySelector('.ai-composer-submit').getBoundingClientRect();
            check(submit.width === 28 && submit.height === 28, tag + ': send size changed');
            const modelButton = fixture.querySelector('.ai-composer-model');
            const effortButton = fixture.querySelector('.ai-composer-effort');
            const modelRect = modelButton?.getBoundingClientRect(), effortRect = effortButton?.getBoundingClientRect();
            const key = width + '/' + locale + '/' + state;
            const dimensions = JSON.stringify([modelRect?.width, effortRect?.width, modelRect?.left, effortRect?.left]);
            if (!snapshots.has(key)) snapshots.set(key, dimensions);
            check(snapshots.get(key) === dimensions, tag + ': model/effort name changed track allocation');
            const modeRect = buttons[0].getBoundingClientRect();
            const center = rect => rect.top + rect.height / 2;
            if (state === 'both') {
              check(Math.abs(modelRect.width - effortRect.width) < 0.5, tag + ': unequal selector tracks');
              if (width < 300) check(effortRect.top > modelRect.bottom, tag + ': narrow selectors must stack');
              else check(Math.abs(center(modelRect) - center(effortRect)) < 0.5, tag + ': selectors must share row');
            }
            if (modelRect) {
              if (width < 520) check(modelRect.top > modeRect.bottom, tag + ': selectors must have own row');
              else check(Math.abs(center(modelRect) - center(modeRect)) < 0.5, tag + ': wide controls must share row');
            } else check(toolbar.getBoundingClientRect().height === 28, tag + ': empty selector row');
            cases++;
            }
          }
        }
      }
    }
    document.getElementById('result').textContent = JSON.stringify({ cases, failures });
  </script>`;
  const path = join(work, "layout.html");
  await writeFile(path, html);
  const processResult = spawnSync(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(work, "browser-profile")}`, "--dump-dom", pathToFileURL(path).href], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(processResult.error);
  assert.equal(processResult.status, 0, processResult.stderr);
  const match = processResult.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
  assert.ok(match, `Browser did not return layout results: ${processResult.stderr}`);
  const result = JSON.parse(match[1]);
  assert.deepEqual(result.failures, [], `Layout failures: ${result.failures.join("\n")}`);
  console.log(`AI composer layout: ${result.cases} cases passed (isolated headless ${fileURLToPath(pathToFileURL(browser))})`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
