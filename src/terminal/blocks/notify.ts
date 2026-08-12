import { get } from "svelte/store";
import { focusedPane, windowFocused } from "../../store/appStore";
import { sendNotification } from "@tauri-apps/plugin-notification";

/**
 * OS 通知の共通経路（#20 のコマンド完了通知と #32 の OSC 9/777 転送で共有）。
 * ここに前面スパム防止のフォーカス判定と重複抑止（dedup/throttle）を集約し、
 * 二重発火や実装の重複を避ける。
 */

/**
 * この paneId の出力で OS 通知を出してよいか。
 *
 * 前面スパム防止：ウィンドウが最前面で、かつ発火ペインが今フォーカス中のペインなら出さない。
 * → ウィンドウが非フォーカス、または別ペイン/別タブ（＝今見ていない）なら出す。
 *
 * **「ウィンドウが最前面か」は appStore の windowFocused ストアだけを見る。**
 * 以前はここで直接 `document.hasFocus()` を読んでいたが、バッジ側（shouldShowPaneBadge）が
 * Tauri の onFocusChanged 起点へ移った結果、**同じ「見ている」を別々の起点で判定する状態**に
 * なっていた。alt-tab 復帰の瞬間に Tauri は true・DOM はまだ false、という食い違いが実際に起き、
 * 「バッジは正しく隠れるのに、見ているペインへ通知だけ飛ぶ」を生む。起点を1つに戻す。
 *
 * 副作用（意図的）: Tauri も DOM も無い環境（vitest の node）ではストアが初期値 true のままなので
 * 「見ている」扱いになり、フォーカス中ペインの通知が出ない。以前は逆に安全側（通知する）へ
 * 倒していたが、そもそも通知 API 自体が無い環境なので実害が無く、
 * **起点を1つに保つ方を優先する**。
 */
export function shouldNotifyForPane(paneId: number): boolean {
  return !get(windowFocused) || get(focusedPane) !== paneId;
}

/** 同一 (title, body) の通知をこの時間(ms)内は抑止する（連打/重複のスパム防止）。
 *  ペイン単位で管理する: グローバル1本だと別ペインの正当な同時通知（broadcast で
 *  同じコマンドを複数ペインに投げた等）が誤って握り潰される。 */
const DEDUP_MS = 3000;
const lastByPane = new Map<number, { key: string; at: number }>();

/**
 * OS 通知を送る。同一ペインで直前と同一内容（title+body）の通知が DEDUP_MS 以内なら握り潰す。
 * 送信は fire-and-forget（許可は起動時 main.ts で一度だけ要求済み）。
 */
export function notifyThrottled(paneId: number, title: string, body: string): void {
  const key = `${title} ${body}`;
  const now = Date.now();
  const last = lastByPane.get(paneId);
  if (last && key === last.key && now - last.at < DEDUP_MS) return;
  lastByPane.set(paneId, { key, at: now });
  void sendNotification({ title, body });
}

/** テスト用：dedup 状態をリセットする。 */
export function __resetNotifyThrottle(): void {
  lastByPane.clear();
}
