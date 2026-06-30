import { config, type OrbConfig } from "./config";
import { convertFileSrc } from "@tauri-apps/api/core";

/** config のアクセント色・背景画像・暗幕を CSS 変数へ流し込む（config が変わるたび自動適用）。
 *  --teal: アクセント / --bg-image: 背景画像(asset URL) / --bg-dim: 暗幕の不透明度。 */
function apply(c: OrbConfig) {
  const root = document.documentElement.style;
  root.setProperty("--teal", c.accent || "#2dd4bf");
  root.setProperty("--bg-image", c.bg_image ? `url("${convertFileSrc(c.bg_image)}")` : "none");
  root.setProperty("--bg-dim", c.bg_image ? String(c.bg_dim ?? 0.6) : "0");
}

config.subscribe(apply);
