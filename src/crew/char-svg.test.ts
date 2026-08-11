import { describe, it, expect } from "vitest";
import { charSvg } from "./char-svg";
import type { CrewPose } from "./model";

const POSES: CrewPose[] = ["running", "waiting", "attention", "done", "failed", "idle"];

describe("charSvg", () => {
  it("全ポーズが SVG を返す", () => {
    for (const p of POSES) {
      const s = charSvg(p, "#4fb3a4");
      expect(s.startsWith("<svg")).toBe(true);
      expect(s).toContain("</svg>");
    }
  });

  it("ポーズごとに中身が違う（＝シルエットが変わる）", () => {
    const seen = new Set(POSES.map((p) => charSvg(p, "#4fb3a4")));
    expect(seen.size).toBe(POSES.length);
  });

  it("腕は頭より後に描く（上げた腕が頭に隠れないための不変条件）", () => {
    const s = charSvg("attention", "#4fb3a4");
    expect(s.indexOf('data-part="arms"')).toBeGreaterThan(s.indexOf('data-part="head"'));
  });

  it("キャラ固有色を使い、状態色では塗らない", () => {
    expect(charSvg("failed", "#9b7fd4")).toContain("#9b7fd4");
    expect(charSvg("failed", "#9b7fd4")).not.toContain("#ff5c8a");
  });

  it("size を渡すと width/height に反映される", () => {
    expect(charSvg("idle", "#4fb3a4", 42)).toContain('width="42"');
  });
});
