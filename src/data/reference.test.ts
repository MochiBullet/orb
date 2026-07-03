import { describe, it, expect } from "vitest";
import { KEY_REFERENCE } from "./reference";

describe("KEY_REFERENCE データ形式 (#47: パレットと info タブ共有の単一ソース)", () => {
  it("keys / desc とも非空", () => {
    for (const r of KEY_REFERENCE) {
      expect(r.keys.trim().length, JSON.stringify(r)).toBeGreaterThan(0);
      expect(r.desc.trim().length, JSON.stringify(r)).toBeGreaterThan(0);
    }
  });

  it("keys は一意（同じキーの説明が二重に並ばない）", () => {
    const keys = KEY_REFERENCE.map((r) => r.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
