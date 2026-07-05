import { describe, it, expect } from "vitest";
import { bgLayerVars, type BgConfig } from "./bg";

const base: BgConfig = {
  bg_image: "C:/pics/wall.jpg",
  bg_dim: 0.6,
  bg_size: "cover",
  bg_pos_x: 50,
  bg_pos_y: 50,
};

describe("bgLayerVars", () => {
  it("画像ありは設定値をそのまま CSS 変数へ", () => {
    expect(bgLayerVars({ ...base, bg_size: "contain", bg_pos_x: 25, bg_pos_y: 80, bg_dim: 0.4 })).toEqual({
      "--bg-dim": "0.4",
      "--term-bg": "transparent",
      "--bg-size": "contain",
      "--bg-position": "25% 80%",
    });
  });

  it("画像なしは中立値へ落とす（クリア後に前の値を残さない）", () => {
    expect(bgLayerVars({ ...base, bg_image: "", bg_size: "contain", bg_pos_x: 25, bg_pos_y: 80 })).toEqual({
      "--bg-dim": "0",
      "--term-bg": "#000",
      "--bg-size": "cover",
      "--bg-position": "center",
    });
  });

  it("bg_size が空なら cover にフォールバック", () => {
    expect(bgLayerVars({ ...base, bg_size: "" })["--bg-size"]).toBe("cover");
  });
});
