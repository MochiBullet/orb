import { config, type OrbConfig } from "./config";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * #21: 背景画像・暗幕・端末背景の CSS 変数を documentElement へ流し込む純関数。
 * - `--bg-image`: 背景画像（asset プロトコル URL）/ 無ければ none
 * - `--bg-dim`: 暗幕の不透明度（画像がある時だけ有効、無ければ 0）
 * - `--term-bg`: 端末コンテナ背景（画像時は透過して背景を透かす・無ければ黒）
 *
 * Settings のライブプレビューからも呼ぶ（config ストアを経由せず＝端末フォーカスを奪わない）。
 */
export function applyBgVars(bgImage: string, bgDim: number) {
  const root = document.documentElement.style;
  const has = !!bgImage;
  root.setProperty("--bg-image", has ? `url("${convertFileSrc(bgImage)}")` : "none");
  root.setProperty("--bg-dim", has ? String(bgDim ?? 0.6) : "0");
  root.setProperty("--term-bg", has ? "transparent" : "#000");
}

/** config のアクセント色・背景を CSS 変数へ流し込む（config が変わるたび自動適用）。 */
function apply(c: OrbConfig) {
  document.documentElement.style.setProperty("--teal", c.accent || "#2dd4bf");
  applyBgVars(c.bg_image, c.bg_dim);
}

config.subscribe(apply);
