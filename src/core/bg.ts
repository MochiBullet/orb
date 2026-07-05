import type { OrbConfig } from "./config";

/** applyBgVars / bgLayerVars が要る設定サブセット（背景まわりのみ）。 */
export type BgConfig = Pick<
  OrbConfig,
  "bg_image" | "bg_dim" | "bg_size" | "bg_pos_x" | "bg_pos_y" | "bg_zoom"
>;

/** ズーム倍率の上限（Settings のスライダ最大値もこれを参照＝単一の真実）。 */
export const BG_ZOOM_MAX = 3;

/** 背景メディアとして動画扱いする拡張子。CSS background-image では動画を出せないため
 *  これらは <video> 要素で、それ以外は <img> でレンダリングする（#66）。 */
const VIDEO_EXT = ["mp4", "webm"];

/** パスの拡張子が動画(mp4/webm)かどうか。Windows パス・大文字混在も許容。 */
export function isVideoPath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  return !!m && VIDEO_EXT.includes(m[1].toLowerCase());
}

/** ズーム倍率を 1..MAX にクランプ（手編集/旧保存値の NaN・範囲外でも scale() を壊さない）。 */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(BG_ZOOM_MAX, Math.max(1, z));
}

/** 既定背景センチネル。config.toml に永続化される可搬な既定値で、実行時に Rust が
 *  config_dir 下へ展開した bg-default.mp4 の実パスへ解決する（マシン非依存）。
 *  Rust 側 config.rs の DEFAULT_BG_SENTINEL と一致させること。 */
export const DEFAULT_BG = "__default__";

/** bg_image が既定センチネル（"__default__"）か。 */
export function isDefaultBg(path: string): boolean {
  return path === DEFAULT_BG;
}

/** 表示に使う実パスへ解決する。センチネルなら展開済みの既定パス、それ以外はそのまま返す。
 *  既定パス未解決（"")のときは "" を返す＝解決完了後の再適用で正しい src になる（過渡的に無背景）。 */
export function resolveBgPath(bgImage: string, defaultBgPath: string): string {
  if (bgImage === DEFAULT_BG) return defaultBgPath || "";
  return bgImage;
}

/**
 * #21/#66: 背景レイヤの CSS 変数値を算出する純関数（DOM/Tauri 非依存＝テスト可能）。
 * 背景は <img>/<video> 共通のメディア要素1枚に統一し、cover/contain・位置・ズームを
 * object-fit / object-position / transform:scale で表現する（縦横比を保つ＝歪まない）。
 * transform-origin を位置%に合わせ、ズーム時は指定した焦点へ寄る。
 * メディア URL(`src`) だけは convertFileSrc が要るので applyBgVars 側（bgMedia ストア）に置く。
 * 画像が無いときは暗幕・フィット・位置・ズームを中立値へ落とし、クリア後に前の値を残さない。
 */
export function bgLayerVars(c: BgConfig): Record<string, string> {
  const has = !!c.bg_image;
  const x = c.bg_pos_x ?? 50;
  const y = c.bg_pos_y ?? 50;
  const pos = `${x}% ${y}%`;
  return {
    "--bg-dim": has ? String(c.bg_dim ?? 0.6) : "0",
    "--term-bg": has ? "transparent" : "#000",
    "--bg-fit": has ? c.bg_size || "cover" : "cover",
    "--bg-position": has ? pos : "center",
    "--bg-transform": has ? `scale(${clampZoom(c.bg_zoom ?? 1)})` : "none",
    "--bg-origin": has ? pos : "center",
  };
}
