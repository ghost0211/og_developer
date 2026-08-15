#!/usr/bin/env node
/**
 * Build the built-in openGauss documentation knowledge base index for the AI
 * assistant from fetched Markdown sources (scripts/fetch-opengauss-docs.mjs).
 *
 * Each document is split on headings into slices. A slice keeps the title
 * context, a keyword line for fast pre-filtering, and truncated body text
 * (code blocks preserved). The output JSON is loaded lazily by the AI panel
 * and searched locally — no network, no embedding model required.
 *
 * Usage:
 *   node scripts/build-opengauss-kb.mjs [--in outputs/opengauss-docs] [--out apps/desktop/public/kb/opengauss-kb.json]
 */
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_IN = "outputs/opengauss-docs";
const DEFAULT_OUT = "apps/desktop/public/kb/opengauss-kb.json";
const MAX_SLICE_CHARS = 1400;
const MAX_SLICES_PER_DOC = 60;

const args = process.argv.slice(2);
const inDir = path.resolve(argValue(args, "--in") ?? DEFAULT_IN);
const outFile = path.resolve(argValue(args, "--out") ?? DEFAULT_OUT);

const CHAPTER_LABELS = {
  sql_reference: "SQL语法参考",
  developer_guide: "开发者指南",
  data_migration_guide: "数据迁移指南",
  database_administration_guide: "数据库管理指南",
};

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function parseFrontmatter(raw) {
  if (!raw.startsWith("---")) return { fields: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { fields: {}, body: raw };
  const fields = {};
  for (const line of raw.slice(3, end).split("\n")) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: raw.slice(end + 4) };
}

function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, "").trim())
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordsFor(chapter, title, heading, body) {
  const words = new Set();
  for (const part of [title, heading, body.slice(0, 400)]) {
    for (const token of part.split(/[\s,;:。，；：（）()"'`#*_\-|/\\]+/)) {
      const t = token.trim().toLowerCase();
      if (t.length >= 2 && t.length <= 24 && !/^\d+$/.test(t) && !words.has(t)) {
        words.add(t);
      }
    }
  }
  // Chinese keyword extraction: keep 2..6 char fragments from headings/title.
  const zh = new Set();
  for (const part of [title, heading]) {
    const cn = part.match(/[\u4e00-\u9fa5]{2,12}/g) ?? [];
    for (const frag of cn) {
      if (frag.length <= 8) zh.add(frag);
    }
  }
  return [...zh, ...[...words].slice(0, 24)].slice(0, 32);
}

async function build() {
  const files = (await walk(inDir)).sort();
  const slices = [];
  let skipped = 0;

  for (const file of files) {
    const rel = path.relative(inDir, file).split(path.sep);
    const chapter = rel[0];
    const chapterLabel = CHAPTER_LABELS[chapter] ?? chapter;
    const raw = await fs.readFile(file, "utf8");
    const { fields, body } = parseFrontmatter(raw);
    const title = fields.title || path.basename(file, ".md");

    // Split on markdown headings.
    const sections = [];
    let current = { heading: "", lines: [] };
    for (const line of body.split("\n")) {
      const m = line.match(/^(#{2,4})\s+(.*)$/);
      if (m && m[2].trim() && m[2].trim().length < 80) {
        sections.push(current);
        current = { heading: stripMarkdown(m[2].trim()), lines: [] };
      } else {
        current.lines.push(line);
      }
    }
    sections.push(current);

    let count = 0;
    for (const section of sections) {
      const clean = stripMarkdown(section.lines.join("\n"));
      if (!clean || clean.length < 30) continue;
      const chunks = splitChunks(clean, MAX_SLICE_CHARS);
      for (const chunk of chunks) {
        if (count >= MAX_SLICES_PER_DOC) {
          skipped += 1;
          break;
        }
        slices.push({
          t: `${chapterLabel} · ${title}`,
          h: section.heading || title,
          k: keywordsFor(chapterLabel, title, section.heading, chunk),
          c: chunk,
        });
        count += 1;
      }
    }
  }

  const json = JSON.stringify({ version: 1, generatedAt: new Date().toISOString().slice(0, 10), count: slices.length, slices });
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, json, "utf8");
  const gzip = await gzipSize(json);
  console.log(`slices: ${slices.length} (skipped ${skipped} oversized)`);
  console.log(`index: ${(json.length / 1024 / 1024).toFixed(1)} MB raw, ~${(gzip / 1024 / 1024).toFixed(1)} MB gzip`);
  console.log(`output: ${outFile}`);
}

function splitChunks(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("。", max);
    if (cut < max / 2) cut = rest.lastIndexOf(".", max);
    if (cut < max / 2) cut = rest.lastIndexOf("；", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function gzipSize(text) {
  const gz = await import("node:zlib");
  return new Promise((resolve) => {
    gz.gzip(text, (err, buf) => resolve(err ? text.length : buf.length));
  });
}

function argValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : undefined;
}

await build();
