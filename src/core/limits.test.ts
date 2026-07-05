import { describe, it, expect } from "vitest";
import { clampFontSize, clampScrollback, FONT_SIZE_MIN, FONT_SIZE_MAX } from "./limits";

describe("clampFontSize", () => {
  it("範囲内はそのまま通す", () => {
    expect(clampFontSize(13)).toBe(13);
    expect(clampFontSize(FONT_SIZE_MIN)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(FONT_SIZE_MAX)).toBe(FONT_SIZE_MAX);
  });
  it("下限/上限にクランプ（0px・巨大値の破損ペインを防ぐ）", () => {
    expect(clampFontSize(0)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(-5)).toBe(FONT_SIZE_MIN);
    expect(clampFontSize(9999)).toBe(FONT_SIZE_MAX);
  });
  it("NaN/非有限は既定の13へ", () => {
    expect(clampFontSize(NaN)).toBe(13);
    expect(clampFontSize(Infinity)).toBe(13);
    expect(clampFontSize(-Infinity)).toBe(13);
  });
});

describe("clampScrollback", () => {
  it("範囲内はそのまま通す", () => {
    expect(clampScrollback(1000)).toBe(1000);
    expect(clampScrollback(100)).toBe(100);
    expect(clampScrollback(100000)).toBe(100000);
  });
  it("下限/上限にクランプ（メモリ膨張・Invalid array length を防ぐ）", () => {
    expect(clampScrollback(0)).toBe(100);
    expect(clampScrollback(1_000_000_000)).toBe(100000);
    expect(clampScrollback(4_294_967_295)).toBe(100000); // u32::MAX 近傍
  });
  it("NaN/非有限は既定の1000へ", () => {
    expect(clampScrollback(NaN)).toBe(1000);
    expect(clampScrollback(Infinity)).toBe(1000);
    expect(clampScrollback(-Infinity)).toBe(1000);
  });
});
