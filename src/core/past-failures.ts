/**
 * 「このエラー、前にも見た？」（Fable5 ロードマップ #3: 過去ログの複利）。
 *
 * #49 の横断検索（同cwd・同コマンド）ヒットから、直近1件の「過去の失敗」と、もしあれば
 * その後の「最初の成功（＝解決）」を見つける純関数。判定ロジックのみ・invoke は呼ばない
 * （レンダラ非依存、vitest 対象）。
 */

import type { SearchHit } from "./blocks-log";

export interface PastFailureMatch {
  /** 直近の過去の失敗ヒット（現在のブロック自身は除外済み）。 */
  failure: SearchHit;
  /** failure より後に、同じコマンドが最初に成功したヒット。見つからなければ null（未解決）。 */
  resolvedBy: SearchHit | null;
}

function isFailure(h: SearchHit): boolean {
  return h.event.exit_code !== 0 || h.event.aborted;
}

function isSuccess(h: SearchHit): boolean {
  return h.event.exit_code === 0 && !h.event.aborted;
}

/**
 * hits は searchSameCommand の戻り値（新しい順＝ hits[0] が最新）を想定。
 * excludeBlockId で現在のブロック自身を除外してから、直近の失敗ヒットを1件探す。
 * 見つかったら、それより後（＝配列上でより手前）に起きた最初の成功ヒットを「解決」として添える。
 * 過去の失敗が1件も無ければ null（＝今回が初めての失敗）。
 */
export function findMostRecentPastFailure(
  hits: SearchHit[],
  excludeBlockId: string,
): PastFailureMatch | null {
  const relevant = hits.filter((h) => h.event.block_id !== excludeBlockId);
  const failIdx = relevant.findIndex(isFailure);
  if (failIdx === -1) return null;
  const failure = relevant[failIdx];

  // failIdx より後に起きた（＝配列の手前側、failIdx-1 から 0 へ向かう）最初の成功を探す。
  // この向きで走査することで「失敗の直後にまず直った瞬間」を取る（ずっと後の成功に飛ばない）。
  let resolvedBy: SearchHit | null = null;
  for (let i = failIdx - 1; i >= 0; i--) {
    if (isSuccess(relevant[i])) {
      resolvedBy = relevant[i];
      break;
    }
  }
  return { failure, resolvedBy };
}
