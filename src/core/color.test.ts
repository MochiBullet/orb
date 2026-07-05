import { describe, it, expect } from "vitest";
import { hexToRgbTriplet } from "./color";

describe("hexToRgbTriplet", () => {
  it("#付き/無しどちらも R, G, B へ変換", () => {
    expect(hexToRgbTriplet("#a78bfa")).toBe("167, 139, 250");
    expect(hexToRgbTriplet("a78bfa")).toBe("167, 139, 250");
  });
  it("大文字混在も許容", () => {
    expect(hexToRgbTriplet("#2DD4BF")).toBe("45, 212, 191");
  });
  it("8桁(#RRGGBBAA)は alpha を無視して RGB のみ変換", () => {
    expect(hexToRgbTriplet("#a78bfaff")).toBe("167, 139, 250");
    expect(hexToRgbTriplet("a78bfa80")).toBe("167, 139, 250");
  });
  it("不正値は白へフォールバック（枠が消えるより無難）", () => {
    expect(hexToRgbTriplet("")).toBe("255, 255, 255");
    expect(hexToRgbTriplet("notacolor")).toBe("255, 255, 255");
    expect(hexToRgbTriplet("#fff")).toBe("255, 255, 255");
  });
});
