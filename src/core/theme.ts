import { config, type OrbConfig } from "./config";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { get, writable } from "svelte/store";
import { bgLayerVars, isVideoPath, resolveBgPath, type BgConfig } from "./bg";
import { hexToRgbTriplet } from "./color";

/** 背景メディア（App.svelte の <img>/<video> が読む）。src は asset プロトコル URL。 */
export type BgMedia = { src: string; video: boolean } | null;

/**
 * #66: 背景メディアの src/種別。CSS 変数では要素の src を渡せないため専用ストアで App.svelte へ。
 * config ストアとは別系統＝Terminal は購読しないので、ライブプレビューで書いても端末の
 * 再描画/フォーカス移動を起こさない（旧 `--bg-image` CSS 変数が担っていた役目のメディア版）。
 */
export const bgMedia = writable<BgMedia>(null);

// 既定背景センチネル("__default__")を解決する実パス（Rust が config_dir 下へ展開した
// bg-default.mp4）。applyBgVars は同期なので、起動時に initDefaultBg が一度 invoke で埋める。
let defaultBgPath = "";

/**
 * #21/#66: 背景の暗幕・端末背景・フィット/位置/ズームの CSS 変数を documentElement へ流し込み、
 * メディア要素の src/種別を bgMedia ストアへ流す。
 * - `--bg-dim`/`--term-bg`/`--bg-fit`/`--bg-position`/`--bg-transform`/`--bg-origin`: bgLayerVars（純関数）
 * - bgMedia: 画像/動画の URL と種別（convertFileSrc + isVideoPath）
 *
 * bg_image の "__default__" センチネルは実パスへ解決してから渡す（isVideoPath 等は実拡張子が要る）。
 * Settings のライブプレビューからも呼ぶ（config ストアを経由せず＝端末フォーカスを奪わない）。
 */
export function applyBgVars(c: BgConfig) {
  const bg = resolveBgPath(c.bg_image, defaultBgPath);
  const rc: BgConfig = { ...c, bg_image: bg };
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(bgLayerVars(rc))) root.setProperty(k, v);
  bgMedia.set(bg ? { src: convertFileSrc(bg), video: isVideoPath(bg) } : null);
}

/**
 * 既定背景センチネルの実パスを Rust に展開させてキャッシュし、現在の config を再適用する。
 * 起動時に main.ts が一度呼ぶ（applyBgVars が以後同期に解決できるよう defaultBgPath を先に埋める）。
 * 失敗しても端末は動く（既定パス未解決なら過渡的に無背景になるだけ）。
 */
export async function initDefaultBg(): Promise<void> {
  try {
    defaultBgPath = await invoke<string>("get_default_bg");
    applyBgVars(get(config));
  } catch (e) {
    console.warn("[orb] default bg resolve failed", e);
  }
}

/** config のアクセント色・AIペイン色・背景を CSS 変数へ流し込む（config が変わるたび自動適用）。 */
function apply(c: OrbConfig) {
  const accent = c.accent || "#2dd4bf";
  const aiAccent = c.ai_accent || "#a78bfa";
  const root = document.documentElement.style;
  root.setProperty("--teal", accent);
  root.setProperty("--violet", aiAccent);
  // #69 followup: 実際の枠線は rgba(167,139,250,X) 決め打ちで --violet を見ていなかった。
  // rgba(var(--violet-rgb), X) で参照できるよう R/G/B 成分も並行して持つ。
  root.setProperty("--violet-rgb", hexToRgbTriplet(aiAccent));
  applyBgVars(c);
}

config.subscribe(apply);
