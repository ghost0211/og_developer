import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function icoDimensions(bytes: Buffer): Array<[number, number]> {
  expect(bytes.readUInt16LE(0)).toBe(0);
  expect(bytes.readUInt16LE(2)).toBe(1);
  const count = bytes.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return [bytes[offset] || 256, bytes[offset + 1] || 256];
  });
}

describe("Windows application icon", () => {
  it("puts a taskbar-quality image first for Tauri's default window icon decoder", () => {
    const dimensions = icoDimensions(readFileSync("src-tauri/icons/icon.ico"));

    expect(dimensions[0]).toEqual([64, 64]);
    expect(new Set(dimensions.map(([width]) => width))).toEqual(new Set([16, 24, 32, 48, 64, 128, 256]));
  });
});
