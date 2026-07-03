import { describe, it, expect } from "vitest";
import { formatImagePath, isImagePath } from "./insert-path";

describe("formatImagePath (#53)", () => {
  it("AI ペインは @パス、通常ペインは素のパス", () => {
    expect(formatImagePath("C:\\Temp\\orb-shots\\orb-1.png", true)).toBe(
      "@C:\\Temp\\orb-shots\\orb-1.png",
    );
    expect(formatImagePath("C:\\Temp\\orb-shots\\orb-1.png", false)).toBe(
      "C:\\Temp\\orb-shots\\orb-1.png",
    );
  });

  it("空白入りパスは引用符で包む（@ は引用の外）", () => {
    expect(formatImagePath("C:\\My Dir\\shot.png", true)).toBe('@"C:\\My Dir\\shot.png"');
    expect(formatImagePath("C:\\My Dir\\shot.png", false)).toBe('"C:\\My Dir\\shot.png"');
  });
});

describe("isImagePath (#53)", () => {
  it("画像拡張子（大小無視）だけ true", () => {
    for (const p of ["a.png", "b.JPG", "c.jpeg", "d.gif", "e.webp", "f.BMP", "dir\\g.png"]) {
      expect(isImagePath(p)).toBe(true);
    }
    for (const p of ["a.txt", "b.png.exe", "c", "d.svg", "e.pngx"]) {
      expect(isImagePath(p)).toBe(false);
    }
  });
});
