import { describe, expect, it } from "vitest";
import { detectBase64Info, formatXml, isWellFormedXml, isWktGeometryText } from "@/lib/dataGrid/richValueDetection";

describe("rich value detection", () => {
  it("does not classify ordinary text as Base64", () => {
    expect(detectBase64Info("password").isBase64).toBe(false);
    expect(detectBase64Info("customer_name").isBase64).toBe(false);
  });

  it("recognizes printable Base64 text and image data", () => {
    expect(detectBase64Info("dGVzdA==")).toMatchObject({ isBase64: true, text: "test", isImage: false });
    expect(detectBase64Info("data:image/png;base64,iVBORw0KGgo=")).toMatchObject({ isBase64: true, isImage: true });
  });

  it("requires well-formed XML before enabling XML preview", () => {
    expect(isWellFormedXml("<root><item /></root>")).toBe(true);
    expect(isWellFormedXml("<hello>")).toBe(false);
    expect(formatXml("<root><item /></root>")).toContain("<item />");
  });

  it("only recognizes WKT geometry structures", () => {
    expect(isWktGeometryText("POINT (1 2)")).toBe(true);
    expect(isWktGeometryText("POINT EMPTY")).toBe(true);
    expect(isWktGeometryText("Point of Contact")).toBe(false);
  });
});
