/**
 * crew スプライトの相対パス解決。
 *
 * config.toml の crew[].sprite は config_dir() からの相対パス（例 "crew/slot0.png"）で
 * 永続化されている（import_crew_sprite 参照）。convertFileSrc は絶対パスしか受け付けないため、
 * 背景動画（core/theme.ts の initDefaultBg）と同じパターンで、起動時に一度 Rust から
 * config_dir() の絶対パスを取得してキャッシュし、以後は同期的に結合するだけにする。
 */
import { invoke } from "@tauri-apps/api/core";
import { writable } from "svelte/store";

let base: string | null = null;

/**
 * base が解決済みかどうか。プレーンな module 変数（base）だけだと Svelte の $effect から見て
 * リアクティブな依存にならない＝boot 完了前に一度 null で諦めたスロットが二度と再解決されない。
 * Crew.svelte 側はこのストアを読むことで、解決完了後に検証 $effect を再実行できる。
 */
export const crewSpriteBaseReady = writable(false);

/**
 * main.ts が boot 時に一度呼ぶ（initDefaultBg と同じ fire-and-forget パターン。
 * mount をブロックしない＝解決前は既定 SVG が出ているだけで端末自体は使える）。
 * 失敗しても base は null のままなので、呼び出し側は既定 SVG へフォールバックし続ける。
 */
export async function initCrewSpriteBase(): Promise<void> {
  try {
    base = await invoke<string>("get_config_dir");
    crewSpriteBaseReady.set(true);
  } catch (e) {
    console.warn("[orb] crew sprite base resolve failed", e);
  }
}

/**
 * slot.sprite（config_dir() 相対パス）を convertFileSrc に渡せる絶対パスへ変換する。
 * base 未解決/取得失敗なら null を返す＝呼び出し側は壊れた URL を convertFileSrc に渡さず、
 * 既定 SVG へフォールバックする。
 * Windows でも convertFileSrc はフォワードスラッシュ区切りを受け付けるため、単純結合でよい。
 */
export function resolveCrewSpritePath(rel: string): string | null {
  if (!base) return null;
  return `${base}/${rel}`;
}
