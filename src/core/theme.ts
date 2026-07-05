import { config, type OrbConfig } from "./config";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writable } from "svelte/store";
import { bgLayerVars, isVideoPath, type BgConfig } from "./bg";

/** 背景メディア（App.svelte の <img>/<video> が読む）。src は asset プロトコル URL。 */
export type BgMedia = { src: string; video: boolean } | null;

/**
 * #66: 背景メディアの src/種別。CSS 変数では要素の src を渡せないため専用ストアで App.svelte へ。
 * config ストアとは別系統＝Terminal は購読しないので、ライブプレビューで書いても端末の
 * 再描画/フォーカス移動を起こさない（旧 `--bg-image` CSS 変数が担っていた役目のメディア版）。
 */
export const bgMedia = writable<BgMedia>(null);

/**
 * #21/#66: 背景の暗幕・端末背景・フィット/位置/ズームの CSS 変数を documentElement へ流し込み、
 * メディア要素の src/種別を bgMedia ストアへ流す。
 * - `--bg-dim`/`--term-bg`/`--bg-fit`/`--bg-position`/`--bg-transform`/`--bg-origin`: bgLayerVars（純関数）
 * - bgMedia: 画像/動画の URL と種別（convertFileSrc + isVideoPath）
 *
 * Settings のライブプレビューからも呼ぶ（config ストアを経由せず＝端末フォーカスを奪わない）。
 */
export function applyBgVars(c: BgConfig) {
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(bgLayerVars(c))) root.setProperty(k, v);
  bgMedia.set(c.bg_image ? { src: convertFileSrc(c.bg_image), video: isVideoPath(c.bg_image) } : null);
}

/** config のアクセント色・背景を CSS 変数へ流し込む（config が変わるたび自動適用）。 */
function apply(c: OrbConfig) {
  document.documentElement.style.setProperty("--teal", c.accent || "#2dd4bf");
  applyBgVars(c);
}

config.subscribe(apply);
