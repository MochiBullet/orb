/**
 * #75 ROB-3: xterm へ渡す前の font_size / scrollback の安全域。Settings の
 * `<input min max>` は助言のみ（手編集の config.toml や将来のバグ値はすり抜ける）ため、
 * xterm 構築・更新の境界（Terminal.svelte）で必ずこのクランプを通す。
 * ズームの手動クランプ（旧: 8..28 決め打ち）ともここで一致させ、単一の真実にする。
 */

/** フォントサイズの下限/上限（px相当）。0 は 0px グリフで FitAddon が no-op になり読めない
 *  空ペインになる／9999 等の巨大値はセルが潰れて使い物にならないため両側で絞る。 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 28;
const FONT_SIZE_DEFAULT = 13;

/** scrollback（行数）の下限/上限。巨大値（10^9等）はメモリ膨張、u32::MAX 近傍は xterm の
 *  バッファ確保で `RangeError: Invalid array length` を起こし onMount ごと落ちる（空/破損ペイン）。 */
const SCROLLBACK_MIN = 100;
const SCROLLBACK_MAX = 100000;
const SCROLLBACK_DEFAULT = 1000;

/** font_size を FONT_SIZE_MIN..FONT_SIZE_MAX にクランプ。NaN/非有限は既定値へ落とす。 */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
}

/** scrollback を SCROLLBACK_MIN..SCROLLBACK_MAX にクランプ。NaN/非有限は既定値へ落とす。 */
export function clampScrollback(n: number): number {
  if (!Number.isFinite(n)) return SCROLLBACK_DEFAULT;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, n));
}
