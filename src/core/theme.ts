import { config, type OrbConfig } from "./config";
import { convertFileSrc } from "@tauri-apps/api/core";
import { bgLayerVars, type BgConfig } from "./bg";

/**
 * #21: 背景画像・暗幕・端末背景の CSS 変数を documentElement へ流し込む。
 * - `--bg-image`: 背景画像（asset プロトコル URL）/ 無ければ none
 * - `--bg-dim`/`--term-bg`/`--bg-size`/`--bg-position`: bgLayerVars（純関数）で算出
 *
 * Settings のライブプレビューからも呼ぶ（config ストアを経由せず＝端末フォーカスを奪わない）。
 */
export function applyBgVars(c: BgConfig) {
  const root = document.documentElement.style;
  root.setProperty("--bg-image", c.bg_image ? `url("${convertFileSrc(c.bg_image)}")` : "none");
  for (const [k, v] of Object.entries(bgLayerVars(c))) root.setProperty(k, v);
}

/** config のアクセント色・背景を CSS 変数へ流し込む（config が変わるたび自動適用）。 */
function apply(c: OrbConfig) {
  document.documentElement.style.setProperty("--teal", c.accent || "#2dd4bf");
  applyBgVars(c);
}

config.subscribe(apply);
