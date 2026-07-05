/**
 * #79 グローバル未捕捉ハンドラ。これまで uncaught error / unhandledrejection は
 * どこにも出ず（console すら経由しないものもある）、フロントが静かに壊れていた。
 * ここは「本当に誰も catch しなかった」最後の砦だけをトーストで拾う。
 * 内部処理済みの logError はトーストに流さない＝スパム防止（意味のある地点で個別に push する）。
 */
import { pushToast } from "../store/toasts";

const MAX = 140;

/** トーストが縦に伸びないよう、改行を畳んで長文を切り詰める。 */
function short(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX ? one.slice(0, MAX - 1) + "…" : one;
}

/** main.ts の起動時に一度だけ呼ぶ。window レベルの未捕捉をトースト化する。 */
export function initGlobalErrorHandlers(): void {
  window.addEventListener("error", (e) => {
    const msg = e.message || String(e.error ?? "不明なエラー");
    pushToast("error", "エラー: " + short(msg));
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    pushToast("error", "未処理の例外: " + short(msg));
  });
}
