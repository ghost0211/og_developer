import { describe, expect, it } from "vitest";
import { highlightMenuSearchText, menuSearchTextMatches } from "@/lib/search/menuSearchMatching";

const insensitive = { caseSensitive: false, wholeWord: false };

describe("menu search matching", () => {
  it("supports case-sensitive filtering", () => {
    expect(menuSearchTextMatches("SalesOrder", "sales", insensitive)).toBe(true);
    expect(menuSearchTextMatches("SalesOrder", "sales", { caseSensitive: true, wholeWord: false })).toBe(false);
  });

  it("supports whole-word filtering without matching identifier fragments", () => {
    const options = { caseSensitive: false, wholeWord: true };
    expect(menuSearchTextMatches("select order_id from orders", "order", options)).toBe(false);
    expect(menuSearchTextMatches("select order from orders", "order", options)).toBe(true);
  });

  it("escapes HTML without corrupting entities when highlighting SQL symbols", () => {
    const html = highlightMenuSearchText("a < 10 AND b & c", "<", insensitive);
    expect(html).toContain("<mark");
    expect(html).toContain("&lt;</mark>");
    expect(html).toContain("b &amp; c");
    expect(html).not.toContain("&<mark");
  });

  it("escapes untrusted source snippets", () => {
    const html = highlightMenuSearchText('<script>alert("x")</script>', "alert", insensitive);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
