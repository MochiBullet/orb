import { describe, it, expect } from "vitest";
import {
  bgLayerVars,
  isVideoPath,
  clampZoom,
  isDefaultBg,
  resolveBgPath,
  DEFAULT_BG,
  BG_ZOOM_MAX,
  type BgConfig,
} from "./bg";

const base: BgConfig = {
  bg_image: "C:/pics/wall.jpg",
  bg_dim: 0.6,
  bg_size: "cover",
  bg_pos_x: 50,
  bg_pos_y: 50,
  bg_zoom: 1,
};

describe("bgLayerVars", () => {
  it("画像ありは設定値をそのまま CSS 変数へ（fit/位置/ズーム/origin）", () => {
    expect(
      bgLayerVars({ ...base, bg_size: "contain", bg_pos_x: 25, bg_pos_y: 80, bg_dim: 0.4, bg_zoom: 1.5 }),
    ).toEqual({
      "--bg-dim": "0.4",
      "--term-bg": "transparent",
      "--bg-fit": "contain",
      "--bg-position": "25% 80%",
      "--bg-transform": "scale(1.5)",
      "--bg-origin": "25% 80%",
    });
  });

  it("画像なしは中立値へ落とす（クリア後に前の値を残さない）", () => {
    expect(
      bgLayerVars({ ...base, bg_image: "", bg_size: "contain", bg_pos_x: 25, bg_pos_y: 80, bg_zoom: 2 }),
    ).toEqual({
      "--bg-dim": "0",
      "--term-bg": "#000",
      "--bg-fit": "cover",
      "--bg-position": "center",
      "--bg-transform": "none",
      "--bg-origin": "center",
    });
  });

  it("bg_size が空なら cover にフォールバック", () => {
    expect(bgLayerVars({ ...base, bg_size: "" })["--bg-fit"]).toBe("cover");
  });

  it("ズーム1は scale(1)（transform-origin は位置に追従）", () => {
    const v = bgLayerVars({ ...base, bg_pos_x: 10, bg_pos_y: 90 });
    expect(v["--bg-transform"]).toBe("scale(1)");
    expect(v["--bg-origin"]).toBe("10% 90%");
  });

  it("範囲外ズームはクランプされる（歪み無しの scale 値を保つ）", () => {
    expect(bgLayerVars({ ...base, bg_zoom: 99 })["--bg-transform"]).toBe(`scale(${BG_ZOOM_MAX})`);
    expect(bgLayerVars({ ...base, bg_zoom: 0 })["--bg-transform"]).toBe("scale(1)");
  });
});

describe("isVideoPath", () => {
  it("mp4/webm は動画（拡張子の大文字混在も許容）", () => {
    expect(isVideoPath("C:/vids/bg.mp4")).toBe(true);
    expect(isVideoPath("C:\\vids\\clip.WEBM")).toBe(true);
    expect(isVideoPath("/home/u/loop.Mp4")).toBe(true);
  });
  it("画像・拡張子無しは動画ではない", () => {
    expect(isVideoPath("C:/pics/wall.jpg")).toBe(false);
    expect(isVideoPath("photo.png")).toBe(false);
    expect(isVideoPath("noext")).toBe(false);
    expect(isVideoPath("")).toBe(false);
  });
});

describe("clampZoom", () => {
  it("1..MAX にクランプ、NaN は 1", () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(2.5)).toBe(2.5);
    expect(clampZoom(0.2)).toBe(1);
    expect(clampZoom(100)).toBe(BG_ZOOM_MAX);
    expect(clampZoom(NaN)).toBe(1);
  });
});

describe("resolveBgPath / isDefaultBg", () => {
  it("センチネルは既定の実パスへ解決", () => {
    expect(isDefaultBg(DEFAULT_BG)).toBe(true);
    expect(resolveBgPath(DEFAULT_BG, "C:/cfg/bg-default.mp4")).toBe("C:/cfg/bg-default.mp4");
  });
  it("既定パス未解決（空）のセンチネルは空＝過渡的に無背景", () => {
    expect(resolveBgPath(DEFAULT_BG, "")).toBe("");
  });
  it("実パス・空文字はそのまま（センチネル扱いしない）", () => {
    expect(isDefaultBg("C:/pics/wall.jpg")).toBe(false);
    expect(isDefaultBg("")).toBe(false);
    expect(resolveBgPath("C:/pics/wall.jpg", "C:/cfg/bg-default.mp4")).toBe("C:/pics/wall.jpg");
    expect(resolveBgPath("", "C:/cfg/bg-default.mp4")).toBe("");
  });
});
