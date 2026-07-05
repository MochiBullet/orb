/**
 * #79 トースト（フロントのエラー可視化基盤）。
 *
 * これまでフロントは console.* だけ＝DevTools を開かない限りエラーが不可視だった。
 * その不在こそが「静かに壊れる」系（背景メディア読込失敗・設定保存失敗・uncaught error）を
 * 静的レビューで見逃した真因。ここは最小の通知基盤で、意味のある失敗地点と
 * グローバル未捕捉ハンドラからだけ pushToast する（logError 全部を流すとスパムになる）。
 *
 * 純ロジック（id 採番・連続重複の抑止）はテスト可能に保つ。表示は Toasts.svelte。
 */
import { writable } from "svelte/store";

export type ToastKind = "error" | "warn" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** 自動消滅（ms）。error は読む時間が要るので長め、info/warn は短め。 */
export const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  error: 10000,
  warn: 6000,
  info: 6000,
};

/** 同一メッセージ連投の抑止窓（ms）。鳴り続ける失敗が N 個積み上がるのを防ぐ。 */
export const DEDUPE_MS = 4000;

/** 表示中トーストの単一ソース（Toasts.svelte が購読）。 */
export const toasts = writable<Toast[]>([]);

// id は単調増加のカウンタ（{#each key} 用に一意でありさえすればよい）。
let nextId = 1;
// 直近に積んだトースト（連続重複の判定用）。
let recent: { kind: ToastKind; message: string; at: number } | null = null;
// id → 自動消滅タイマー（dismiss 時に確実に clear するため保持）。
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * トーストを1件積む。直前と同一 (kind+message) を短窓(DEDUPE_MS)内で受けたら
 * 抑止して null を返す（窓は延長＝失敗が鳴り続ける間も 1 個のまま）。積めたら id を返す。
 */
export function pushToast(kind: ToastKind, message: string): number | null {
  const now = Date.now();
  if (recent && recent.kind === kind && recent.message === message && now - recent.at < DEDUPE_MS) {
    recent.at = now; // 窓を延長（連続失敗中は増やさない）
    return null;
  }
  recent = { kind, message, at: now };
  const id = nextId++;
  toasts.update((list) => [...list, { id, kind, message }]);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), AUTO_DISMISS_MS[kind]),
  );
  return id;
}

/** id 指定で1件消す（× / クリック / 自動消滅の共通経路）。タイマーも確実に止める。 */
export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t != null) {
    clearTimeout(t);
    timers.delete(id);
  }
  toasts.update((list) => list.filter((x) => x.id !== id));
}

/** テスト用: モジュール状態（id カウンタ・重複窓・タイマー・表示配列）を初期化。 */
export function __resetToastsForTest(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  recent = null;
  nextId = 1;
  toasts.set([]);
}
