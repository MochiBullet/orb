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
// 直近に積んだトースト（連続重複の判定用。id も持ち、dismiss 時に自分の記録か判定する）。
let recent: { kind: ToastKind; message: string; at: number; id: number } | null = null;
// id → 自動消滅タイマー（dismiss 時に確実に clear するため保持）。
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * トーストを1件積む。直前と同一 (kind+message) を短窓(DEDUPE_MS)内で受けたら
 * 抑止して null を返す。積めたら id を返す。
 *
 * 窓は「初回発生時刻」起点で固定し、抑止のたびに延長(re-arm)しない。re-arm すると
 * 同一失敗が DEDUPE_MS 未満の間隔で鳴り続ける限り永遠に新規トーストが積めず、
 * 既存の1個は自動消滅(10s)して何も残らない＝「静かに壊れる」を #79 の目的に反して
 * 再発させてしまう。窓を初回起点固定にすることで、鳴り続けていても DEDUPE_MS 毎に
 * 必ず1個は再表示される。
 */
export function pushToast(kind: ToastKind, message: string): number | null {
  const now = Date.now();
  if (recent && recent.kind === kind && recent.message === message && now - recent.at < DEDUPE_MS) {
    return null;
  }
  const id = nextId++;
  recent = { kind, message, at: now, id };
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
  // 消えたトーストが重複抑止の記録元だったら記録も消す＝直後に同じ失敗が再発しても
  // 隠さず出す（手動 × でも自動消滅でも、表示されていたものが無くなった以上、抑止は不要）。
  if (recent && recent.id === id) recent = null;
}

/** テスト用: モジュール状態（id カウンタ・重複窓・タイマー・表示配列）を初期化。 */
export function __resetToastsForTest(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  recent = null;
  nextId = 1;
  toasts.set([]);
}
