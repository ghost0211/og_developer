import { describe, expect, it, vi } from "vitest";
import { createAiShikiCodeHighlighter } from "@/lib/ai/aiCodeHighlighter";

const appearance = () => "dark" as const;

describe("createAiShikiCodeHighlighter", () => {
  it("highlights the grammars in the eager set on the first call", async () => {
    const highlight = await createAiShikiCodeHighlighter({ appearance });

    const html = highlight("select 1", "sql");

    expect(html).toContain("<span");
    expect(html).not.toContain("&lt;");
    expect(html).toContain("select");
  });

  it("highlights through grammar aliases declared by an eager grammar", async () => {
    const highlight = await createAiShikiCodeHighlighter({ appearance });

    // `bash` is an alias of the eagerly loaded `shellscript` grammar.
    const html = highlight("gsql -d postgres", "bash");

    expect(html).toContain("<span");
  });

  it("escapes plain text for languages with no grammar", async () => {
    const highlight = await createAiShikiCodeHighlighter({ appearance });

    const html = highlight("<script>alert(1)</script> & more", "MONGODB");

    expect(html).toBe("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
  });

  it("escapes the first frame of a deferred grammar, then highlights once it arrives", async () => {
    const onLanguageLoaded = vi.fn();
    const highlight = await createAiShikiCodeHighlighter({ appearance, onLanguageLoaded });

    const beforeLoad = highlight("<?php echo 1; ?>", "php");
    expect(beforeLoad).toBe("&lt;?php echo 1; ?&gt;");
    expect(onLanguageLoaded).not.toHaveBeenCalled();
    expect(highlight("<?php echo 1; ?>", "PHP")).toBe(beforeLoad);

    await vi.waitFor(() => {
      expect(onLanguageLoaded).toHaveBeenCalledWith("php");
    });

    const afterLoad = highlight("<?php echo 1; ?>", "php");
    expect(afterLoad).toContain("<span");
    expect(afterLoad).not.toBe(beforeLoad);
  });

  it("maps the appearance option to the matching theme", async () => {
    const highlight = await createAiShikiCodeHighlighter({ appearance: () => "light" });

    expect(highlight("select 1", "sql", "light")).toContain("<span");
    expect(highlight("select 1", "sql", "light")).not.toBe(highlight("select 1", "sql", "dark"));
  });

  it("keeps an unknown language as plain text after the appearance changes", async () => {
    const highlight = await createAiShikiCodeHighlighter({ appearance });

    expect(highlight("plain", "not-a-language")).toBe("plain");
  });
});
