import { describe, it, expect } from "vitest";
import { validateSheet, frameRect, SPRITE_ORDER } from "./sprite";

describe("validateSheet", () => {
  it("横に6コマ・各コマ正方形なら通す", () => {
    expect(validateSheet(384, 64)).toEqual({ ok: true, frame: 64 });
    expect(validateSheet(768, 128)).toEqual({ ok: true, frame: 128 });
  });

  it("コマが正方形でなければ理由を付けて弾く", () => {
    const r = validateSheet(384, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("6");
  });

  it("寸法が0や負なら弾く", () => {
    expect(validateSheet(0, 64).ok).toBe(false);
    expect(validateSheet(384, 0).ok).toBe(false);
  });
});

describe("frameRect", () => {
  it("並び順どおりの位置を返す", () => {
    expect(frameRect("running", 64)).toEqual({ x: 0, y: 0, w: 64, h: 64 });
    expect(frameRect("idle", 64)).toEqual({ x: 320, y: 0, w: 64, h: 64 });
  });

  it("並び順は6ポーズちょうど", () => {
    expect(SPRITE_ORDER).toHaveLength(6);
    expect(new Set(SPRITE_ORDER).size).toBe(6);
  });
});
