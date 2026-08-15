#!/usr/bin/env node
/**
 * Fetch openGauss official documentation (Markdown sources) for the built-in
 * AI knowledge base.
 *
 * Sources are the openGauss community docs mirror on GitHub
 * (https://github.com/opengauss-mirror/docs, docs/zh/<chapter>/<file>.md),
 * which is the exact source behind https://docs.opengauss.org.
 *
 * Usage:
 *   node scripts/fetch-opengauss-docs.mjs [--chapter sql_reference] [--out outputs/opengauss-docs]
 *
 * The GitHub contents API is only used to list each chapter directory (one
 * request per chapter); file bodies are downloaded from raw.githubusercontent.com
 * which is not rate-limited the same way.
 */
import fs from "node:fs/promises";
import path from "node:path";

const API = "https://api.github.com/repos/opengauss-mirror/docs/contents/docs/zh";
const RAW = "https://raw.githubusercontent.com/opengauss-mirror/docs/master/docs/zh";

const DEFAULT_CHAPTERS = ["sql_reference", "developer_guide", "data_migration_guide"];
const DEFAULT_OUT = "outputs/opengauss-docs";

const args = process.argv.slice(2);
const chapters = argValue(args, "--chapter")?.split(",").filter(Boolean) ?? DEFAULT_CHAPTERS;
const outDir = path.resolve(argValue(args, "--out") ?? DEFAULT_OUT);
const force = args.includes("--force");

async function listChapterFiles(chapter) {
  const url = `${API}/${chapter}`;
  const res = await fetch(url, { headers: { "User-Agent": "ogdeveloper-kb-builder" } });
  if (!res.ok) throw new Error(`Failed to list ${chapter}: HTTP ${res.status}`);
  const entries = await res.json();
  return entries.filter((e) => e.type === "file" && e.name.endsWith(".md")).map((e) => e.name);
}

async function downloadFile(chapter, file, outPath) {
  const url = `${RAW}/${chapter}/${encodeURIComponent(file)}`;
  const res = await fetch(url, { headers: { "User-Agent": "ogdeveloper-kb-builder" } });
  if (!res.ok) throw new Error(`Failed to download ${chapter}/${file}: HTTP ${res.status}`);
  const text = await res.text();
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, text, "utf8");
}

let totalFiles = 0;
let totalBytes = 0;
for (const chapter of chapters) {
  const files = await listChapterFiles(chapter);
  console.log(`[${chapter}] ${files.length} files`);
  for (const file of files) {
    const outPath = path.join(outDir, chapter, file);
    if (!force && (await fs.stat(outPath).catch(() => null))) continue;
    await downloadFile(chapter, file, outPath);
    totalFiles += 1;
    totalBytes += (await fs.stat(outPath)).size;
  }
}
console.log(`\nDone: ${totalFiles} files downloaded, ${(totalBytes / 1024 / 1024).toFixed(1)} MB → ${outDir}`);

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}
