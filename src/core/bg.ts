import type { OrbConfig } from "./config";

/** applyBgVars / bgLayerVars が要る設定サブセット（背景まわりのみ）。 */
export type BgConfig = Pick<OrbConfig, "bg_image" | "bg_dim" | "bg_size" | "bg_pos_x" | "bg_pos_y">;

/**
 * #21: 背景レイヤの CSS 変数値を算出する純関数（DOM/Tauri 非依存＝テスト可能）。
 * 画像 URL(`--bg-image`) だけは Tauri の convertFileSrc が要るので applyBgVars 側に置く。
 * 画像が無いときは暗幕・サイズ・位置を中立値へ落とし、クリア後に前の値が残らないようにする。
 */
export function bgLayerVars(c: BgConfig): Record<string, string> {
  const has = !!c.bg_image;
  return {
    "--bg-dim": has ? String(c.bg_dim ?? 0.6) : "0",
    "--term-bg": has ? "transparent" : "#000",
    "--bg-size": has ? c.bg_size || "cover" : "cover",
    "--bg-position": has ? `${c.bg_pos_x ?? 50}% ${c.bg_pos_y ?? 50}%` : "center",
  };
}
