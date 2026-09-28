import { describe, expect, it } from "vitest";
import { charDisplayWidth, displayWidth, padEndToWidth, truncateToWidth } from "@/lib/common/displayWidth";

describe("displayWidth", () => {
  it("ASCII 字符每字符 1 列", () => {
    expect(displayWidth("dict_code")).toBe(9);
    expect(displayWidth("ACTIVE")).toBe(6);
    expect(displayWidth("")).toBe(0);
  });

  it("CJK 汉字每字符 2 列", () => {
    expect(displayWidth("鉴权方式")).toBe(8);
    expect(displayWidth("主数据标记")).toBe(10);
  });

  it("中英文混排按实际显示宽度求和", () => {
    expect(displayWidth("API调用范围")).toBe(3 + 8);
    expect(displayWidth("菜单操作的标准语义分类")).toBe(22); // 11 个汉字
  });

  it("全角标点计 2 列", () => {
    expect(displayWidth("，。！？")).toBe(8);
    expect(displayWidth("￥")).toBe(2);
  });

  it("假名与谚文计 2 列", () => {
    expect(displayWidth("あいう")).toBe(6);
    expect(displayWidth("한글")).toBe(4);
  });

  it("组合字符与控制字符计 0 列", () => {
    expect(charDisplayWidth(0x0301)).toBe(0); // 组合重音符
    expect(charDisplayWidth(0x200b)).toBe(0); // 零宽空格
    expect(charDisplayWidth(0x0a)).toBe(0); // 换行
    expect(displayWidth("é")).toBe(1); // e + 组合重音符
  });

  it("Emoji（代理对）按 2 列处理", () => {
    expect(displayWidth("😀")).toBe(2); // U+1F600
  });
});

describe("padEndToWidth", () => {
  it("中文内容按显示宽度补齐而非字符数", () => {
    expect(padEndToWidth("鉴权方式", 10)).toBe("鉴权方式  ");
    expect(padEndToWidth("ACTIVE", 10)).toBe("ACTIVE    ");
    // 两行补齐后的显示宽度一致 —— 这是表格边框对齐的关键
    expect(displayWidth(padEndToWidth("鉴权方式", 10))).toBe(10);
    expect(displayWidth(padEndToWidth("ACTIVE", 10))).toBe(10);
  });

  it("已达标或超宽时原样返回", () => {
    expect(padEndToWidth("abcdef", 3)).toBe("abcdef");
    expect(padEndToWidth("中文", 4)).toBe("中文");
  });
});

describe("truncateToWidth", () => {
  it("未超宽时原样返回", () => {
    expect(truncateToWidth("abc中文", 10)).toBe("abc中文");
  });

  it("超宽时截断并追加省略号，且总宽度不超限", () => {
    const result = truncateToWidth("菜单操作的标准语义分类", 10);
    expect(result.endsWith("...")).toBe(true);
    expect(displayWidth(result)).toBeLessThanOrEqual(10);
    expect(result).toBe("菜单操..."); // 3 个汉字 6 列 + ... 3 列 = 9 ≤ 10
  });

  it("截断边界不会把宽字符劈开", () => {
    const result = truncateToWidth("abcd中文ef", 6); // budget = 3 → 截断在 abc
    expect(result).toBe("abc...");
    expect(displayWidth(result)).toBeLessThanOrEqual(6);
  });
});
