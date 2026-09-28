/**
 * 等宽终端/编辑器中的字符串显示宽度计算。
 *
 * `String.length` 把每个字符计 1，但东亚宽字符（CJK、全角、假名、谚文等）在等宽
 * 字体下占 2 个显示列，组合字符（变音符号等）占 0 列。ASCII 表格若按 `length`
 * 补齐边框，一旦内容含中文就会错位——所有表格排版（命令窗口、悬停表结构等）
 * 都应改用这里的宽度函数。
 */

/** 宽字符码位区间（计 2 列）。基于常用 wcwidth 表精简，覆盖 CJK/假名/谚文/全角/Emoji。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2329, 0x232a], // 尖括号
  [0x2e80, 0x303e], // CJK 部首、康熙部首、表意符号
  [0x3041, 0x33ff], // 平/片假名、CJK 符号与兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字（常用汉字）
  [0xa000, 0xa4cf], // 彝文音节
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul 音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe6f], // CJK 兼容形式、小形式变体
  [0xff00, 0xff60], // 全角形式（，。！？０Ａａ等）
  [0xffe0, 0xffe6], // 全角符号（￥￣等）
  [0x1f300, 0x1f64f], // Emoji
  [0x1f900, 0x1f9ff], // 补充符号与象形文字
  [0x20000, 0x2fffd], // CJK 扩展 B-F
  [0x30000, 0x3fffd], // CJK 扩展 G+
];

/** 零宽码位区间（计 0 列）：组合符号、变体选择符、零宽控制字符。 */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // 组合附加符号
  [0x0483, 0x0489], // 西里尔组合符号
  [0x0591, 0x05bd], // 希伯来组合符号
  [0x0610, 0x061a], // 阿拉伯组合符号
  [0x064b, 0x065f],
  [0x200b, 0x200f], // 零宽空格/连接符
  [0x202a, 0x202e], // 双向控制
  [0x2060, 0x2064], // 词连接符等
  [0xfe00, 0xfe0f], // 变体选择符
  [0xfeff, 0xfeff], // BOM / 零宽不换行空格
];

function inRanges(ranges: ReadonlyArray<readonly [number, number]>, cp: number): boolean {
  for (const [lo, hi] of ranges) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** 单个码位的显示宽度：控制字符与组合字符 0，宽字符 2，其余 1。 */
export function charDisplayWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (inRanges(ZERO_RANGES, codePoint)) return 0;
  if (inRanges(WIDE_RANGES, codePoint)) return 2;
  return 1;
}

/** 字符串的等宽显示宽度（按码位迭代，正确处理代理对/Emoji）。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charDisplayWidth(ch.codePointAt(0)!);
  }
  return width;
}

/** 按显示宽度向右补空格，使总宽度达到 targetWidth（已达标则原样返回）。 */
export function padEndToWidth(text: string, targetWidth: number): string {
  const gap = targetWidth - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

/**
 * 按显示宽度截断：总宽度超过 maxWidth 时截断并追加省略号，
 * 保证返回值的显示宽度不超过 maxWidth；不会把宽字符从中劈开。
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "..."): string {
  if (displayWidth(text) <= maxWidth) return text;
  const budget = Math.max(0, maxWidth - displayWidth(ellipsis));
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charDisplayWidth(ch.codePointAt(0)!);
    if (width + w > budget) break;
    out += ch;
    width += w;
  }
  return out + ellipsis;
}
