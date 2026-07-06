/**
 * #51 プロンプトキュー: 実行中の AI ペインに「次の指示」を積んでおき、
 * ペインが入力待ち（#50 の paneStatus "waiting"）になったら自動投入する。
 *
 * 構成は2層:
 * - 純関数層（q* 系）: Map を不変更新するだけのキュー操作。vitest 対象。
 * - エンジン層: paneStatus / broadcast を購読し、waiting になったら先頭アイテムを
 *   「送信予約(armed)」→ 3 秒の可視キャンセル猶予 → まだ waiting なら送信して dequeue。
 *
 * 送信は bracketed paste + Enter(\r)。本アプリの原則（Enter は人が押す）の例外で、
 * キューに積む行為自体がユーザーの明示同意（issue #51 の仕様）。
 *
 * 二重送信防止（最重要バグ面）:
 * - 予約は paneId ごとに 1 個（armedPanes）。タイマーは Date.now 基準の単発 setTimeout。
 * - 発火時に「まだ waiting か・先頭アイテムが予約時と同一か・paused/broadcast でないか」を
 *   再検証してから送る＝予約後に世界が変わっていたら送らない。
 * - 送信直後は holdPanes に入れ、そのペインの status が動くまで次弾を予約しない
 *   （claude が沈黙したまま waiting が続いても連射しない）。
 */
import { writable, get } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { paneStatus, broadcast } from "./appStore";
import type { PaneStatus } from "../core/agent-status";
import { frameBracketedPaste } from "../core/ai-payload";
import { genId } from "../core/blocks-log";
import { logError } from "../core/log";

export interface QueueItem {
  id: string;
  paneId: number;
  text: string;
}

export interface PaneQueue {
  /** 上から送信順。 */
  items: QueueItem[];
  /** true = 自動送信を一時停止（送信後の failed で立つ。UI から再開）。 */
  paused: boolean;
}

export type QueueMap = ReadonlyMap<number, PaneQueue>;

// ============================== 純関数層（vitest 対象） ==============================

/** items が空になったエントリは Map から落とす（空キューの paused は意味を持たない）。 */
function normalize(map: Map<number, PaneQueue>, paneId: number): Map<number, PaneQueue> {
  const q = map.get(paneId);
  if (q && q.items.length === 0) map.delete(paneId);
  return map;
}

/** 末尾に追加。エントリが無ければ新規作成（paused=false）。 */
export function qEnqueue(map: QueueMap, item: QueueItem): QueueMap {
  const next = new Map(map);
  const q = next.get(item.paneId);
  next.set(item.paneId, {
    items: q ? [...q.items, item] : [item],
    paused: q?.paused ?? false,
  });
  return next;
}

/** 先頭に戻す（送信失敗時の復元用）。 */
export function qEnqueueFront(map: QueueMap, item: QueueItem): QueueMap {
  const next = new Map(map);
  const q = next.get(item.paneId);
  next.set(item.paneId, {
    items: q ? [item, ...q.items] : [item],
    paused: q?.paused ?? false,
  });
  return next;
}

/** 先頭を取り出す。空なら item=undefined で map は不変。 */
export function qDequeue(map: QueueMap, paneId: number): { map: QueueMap; item?: QueueItem } {
  const q = map.get(paneId);
  if (!q || q.items.length === 0) return { map };
  const next = new Map(map);
  next.set(paneId, { ...q, items: q.items.slice(1) });
  return { map: normalize(next, paneId), item: q.items[0] };
}

/** itemId で1件削除。見つからなければ不変。 */
export function qRemove(map: QueueMap, itemId: string): QueueMap {
  for (const [paneId, q] of map) {
    if (!q.items.some((it) => it.id === itemId)) continue;
    const next = new Map(map);
    next.set(paneId, { ...q, items: q.items.filter((it) => it.id !== itemId) });
    return normalize(next, paneId);
  }
  return map;
}

/** itemId のテキストを書き換える。見つからなければ不変。 */
export function qUpdate(map: QueueMap, itemId: string, text: string): QueueMap {
  for (const [paneId, q] of map) {
    const idx = q.items.findIndex((it) => it.id === itemId);
    if (idx < 0) continue;
    const items = q.items.slice();
    items[idx] = { ...items[idx], text };
    const next = new Map(map);
    next.set(paneId, { ...q, items });
    return next;
  }
  return map;
}

/** itemId を delta（-1=上へ / +1=下へ）動かす。端で止まる。見つからなければ不変。 */
export function qMove(map: QueueMap, itemId: string, delta: -1 | 1): QueueMap {
  for (const [paneId, q] of map) {
    const idx = q.items.findIndex((it) => it.id === itemId);
    if (idx < 0) continue;
    const to = idx + delta;
    if (to < 0 || to >= q.items.length) return map;
    const items = q.items.slice();
    [items[idx], items[to]] = [items[to], items[idx]];
    const next = new Map(map);
    next.set(paneId, { ...q, items });
    return next;
  }
  return map;
}

/** ペインのキューを丸ごと破棄（ペインクローズ時）。 */
export function qClearPane(map: QueueMap, paneId: number): QueueMap {
  if (!map.has(paneId)) return map;
  const next = new Map(map);
  next.delete(paneId);
  return next;
}

/** paused フラグの設定。エントリが無ければ不変（空キューを paused で作らない）。 */
export function qSetPaused(map: QueueMap, paneId: number, paused: boolean): QueueMap {
  const q = map.get(paneId);
  if (!q || q.paused === paused) return map;
  const next = new Map(map);
  next.set(paneId, { ...q, paused });
  return next;
}

// ============================== ストア＋エンジン層 ==============================

/** ペイン毎キュー（paneId → PaneQueue）。UI（一覧・バッジ）の単一ソース。 */
export const queues = writable<QueueMap>(new Map());

/** 送信予約。sendAt = 送信予定時刻(Date.now 基準)＝UI のカウントダウン用。 */
export interface ArmedState {
  itemId: string;
  sendAt: number;
}

/** 予約中ペイン（paneId → ArmedState）。paneId 毎に必ず 1 個以下。 */
export const armedPanes = writable<ReadonlyMap<number, ArmedState>>(new Map());

/** 可視キャンセル猶予（ms）。 */
export const GRACE_MS = 3000;

// 単発タイマー（paneId 毎に 1 個。armedPanes と常に同期）。
const timers = new Map<number, ReturnType<typeof setTimeout>>();
// 送信直後・手動キャンセル後の「status が動くまで再予約しない」抑止セット。
const holdPanes = new Set<number>();
// #Theme-F: 破棄済みペイン（disposePaneQueue 済み）。fire() の非同期送信中にペインが破棄されると、
// 送信失敗の catch が qEnqueueFront で「死んだペインの新規キュー」を作ってしまう（誰も掃除しない
// リーク＝一時停止アイテムが幽霊として残る）。catch はここを見て、破棄済みなら蘇生を諦める。
// #3: paneId は単調増加で正しさ上は無限に増えても壊れないが、閉じたペイン1個につき1エントリが
// 溜まり続けるのは無駄。実際に意味があるのは「破棄直後にまだ inflight の送信が1件残っているか」
// だけなので、上限を設けて超えたら挿入順で最も古いものから捨てる（大昔に破棄したペインの送信が
// 今頃 catch に来ることは実運用上ない＝ガードの実効性は損なわない）。
const disposedPanes = new Set<number>();
const DISPOSED_PANES_CAP = 500;

/** disposedPanes へ追加。上限超過時は最古のエントリ（Set は挿入順）を1個追い出す。 */
function markDisposed(paneId: number): void {
  disposedPanes.add(paneId);
  if (disposedPanes.size > DISPOSED_PANES_CAP) {
    const oldest = disposedPanes.values().next().value;
    if (oldest !== undefined) disposedPanes.delete(oldest);
  }
}

// 送信実装（テストで差し替え可能）。bracketed paste + \r ＝自動投入（#51 の例外仕様）。
let sendImpl: (paneId: number, text: string) => Promise<void> = async (paneId, text) => {
  const bytes = new TextEncoder().encode(frameBracketedPaste(text) + "\r");
  await invoke("write_pty", { paneId, data: Array.from(bytes) });
};

/** テスト用: 送信関数を差し替える。 */
export function __setSendForTest(fn: (paneId: number, text: string) => Promise<void>): void {
  sendImpl = fn;
}

/** armedPanes からエントリを消すだけ（タイマーは呼び出し側の責任）。 */
function removeArmed(paneId: number) {
  armedPanes.update((m) => {
    if (!m.has(paneId)) return m;
    const next = new Map(m);
    next.delete(paneId);
    return next;
  });
}

/** 予約解除（タイマー停止＋armed 解除）。アイテムはキューに残る。 */
function disarm(paneId: number) {
  const t = timers.get(paneId);
  if (t != null) {
    clearTimeout(t);
    timers.delete(paneId);
  }
  removeArmed(paneId);
}

/** 条件が揃っていれば先頭アイテムを送信予約する。揃っていなければ何もしない。 */
function tryArm(paneId: number) {
  if (get(broadcast)) return; // 多重複製事故防止: broadcast 中は保留
  if (holdPanes.has(paneId)) return; // 送信直後/手動キャンセル後は status が動くまで撃たない
  if (get(armedPanes).has(paneId)) return; // 予約は paneId 毎に 1 個
  const q = get(queues).get(paneId);
  if (!q || q.paused || q.items.length === 0) return;
  if (get(paneStatus).get(paneId) !== "waiting") return; // attention 等では絶対に予約しない
  const itemId = q.items[0].id;
  armedPanes.update((m) => new Map(m).set(paneId, { itemId, sendAt: Date.now() + GRACE_MS }));
  timers.set(
    paneId,
    setTimeout(() => fire(paneId), GRACE_MS),
  );
}

/** 猶予満了。予約時の世界がまだ有効かを再検証してから送信・dequeue する。 */
function fire(paneId: number) {
  timers.delete(paneId);
  const st = get(armedPanes).get(paneId);
  removeArmed(paneId);
  if (!st) return;
  // 再検証（予約後に世界が変わっていたら送らない＝二重送信・誤爆防止の要）。
  if (get(broadcast)) return;
  const q = get(queues).get(paneId);
  if (!q || q.paused || q.items.length === 0 || q.items[0].id !== st.itemId) return;
  if (get(paneStatus).get(paneId) !== "waiting") return;
  const { map, item } = qDequeue(get(queues), paneId);
  if (!item) return;
  queues.set(map);
  holdPanes.add(paneId); // status が動くまで次弾を予約しない（連射防止）
  void sendImpl(paneId, item.text).catch((e) => {
    // 送信自体が失敗＝アイテムを先頭へ戻して一時停止（黙って握り潰さない・二重送信もしない）。
    logError(`prompt-queue: pane ${paneId} send failed: ${String(e)}`);
    // #Theme-F: 送信中にペインが破棄されていたら蘇生しない（死んだペインの幽霊キューを作らない）。
    if (disposedPanes.has(paneId)) return;
    queues.update((m) => qSetPaused(qEnqueueFront(m, item), paneId, true));
  });
}

/** キュー編集後の予約整合。予約中アイテムが先頭でなくなったら予約を張り直す。 */
function reconcileArm(paneId: number) {
  const st = get(armedPanes).get(paneId);
  if (!st) {
    tryArm(paneId);
    return;
  }
  const q = get(queues).get(paneId);
  if (!q || q.paused || q.items.length === 0 || q.items[0].id !== st.itemId) {
    disarm(paneId);
    tryArm(paneId);
  }
}

// ---- paneStatus 購読: 変化したペインだけ処理（waiting 遷移で予約、離脱で解除、failed で一時停止）。
let prevStatus: ReadonlyMap<number, PaneStatus> = new Map();
paneStatus.subscribe((map) => {
  const paneIds = new Set([...map.keys(), ...prevStatus.keys()]);
  for (const paneId of paneIds) {
    const cur = map.get(paneId);
    if (cur === prevStatus.get(paneId)) continue;
    holdPanes.delete(paneId); // status が動いた＝送信直後/キャンセル後の抑止を解く
    if (cur !== "waiting") disarm(paneId); // 猶予中に attention/running 等へ → 予約解除（アイテムは残す）
    if (cur === "failed") {
      // 失敗の上に自動で重ねない: キューが残っていれば一時停止（再開は UI から）。
      queues.update((m) => qSetPaused(m, paneId, true));
    }
    if (cur === "waiting") tryArm(paneId);
  }
  prevStatus = map;
});

// ---- broadcast 購読: ON で全予約解除（アイテムは残す）、OFF で再評価。
broadcast.subscribe((on) => {
  if (on) {
    for (const paneId of [...get(armedPanes).keys()]) disarm(paneId);
  } else {
    for (const paneId of [...get(queues).keys()]) tryArm(paneId);
  }
});

// ============================== UI 向け操作 API ==============================

/** キューへ追加。ペインが既に waiting なら即予約が走る。空文字は積まない。 */
export function enqueuePrompt(paneId: number, text: string): void {
  if (!text.trim()) return;
  queues.update((m) => qEnqueue(m, { id: genId(), paneId, text }));
  tryArm(paneId);
}

export function removePrompt(paneId: number, itemId: string): void {
  queues.update((m) => qRemove(m, itemId));
  reconcileArm(paneId);
}

/** 見つかって書き換えられたら true。#5: 予約の猶予中に fire() 済みで既にキューから
 *  消えていた場合は qUpdate が不変（同一参照）を返す＝false。呼び出し側はこれを見て
 *  「もう送信済みで編集は反映されなかった」ことを利用者に伝える。 */
export function updatePrompt(itemId: string, text: string): boolean {
  if (!text.trim()) return false;
  let found = false;
  queues.update((m) => {
    const next = qUpdate(m, itemId, text);
    found = next !== m;
    return next;
  });
  return found;
}

/** #5: 編集開始時の予約一時停止。cancelArmed と違い holdPanes は立てない＝編集終了後に
 *  resumeArmAfterEdit で即座に再評価できる（status 変化を待たせない）。予約が無ければ何もしない。 */
export function pauseArmForEdit(paneId: number): void {
  disarm(paneId);
}

/** #5: 編集終了（更新確定・編集中止・オーバーレイを閉じる）時の再評価。条件が揃っていれば
 *  即座に予約を張り直す。 */
export function resumeArmAfterEdit(paneId: number): void {
  tryArm(paneId);
}

export function movePrompt(paneId: number, itemId: string, delta: -1 | 1): void {
  queues.update((m) => qMove(m, itemId, delta));
  reconcileArm(paneId);
}

/** 送信予約のキャンセル。アイテムはキューに残し、次に status が動くまで再予約しない。 */
export function cancelArmed(paneId: number): void {
  if (!get(armedPanes).has(paneId)) return;
  disarm(paneId);
  holdPanes.add(paneId);
}

/** 一時停止からの再開（UI の再開ボタン）。条件が揃っていれば即予約。 */
export function resumePane(paneId: number): void {
  holdPanes.delete(paneId);
  queues.update((m) => qSetPaused(m, paneId, false));
  tryArm(paneId);
}

/** ペイン破棄時の全掃除（Terminal.svelte の onDestroy から）。 */
export function disposePaneQueue(paneId: number): void {
  disarm(paneId);
  holdPanes.delete(paneId);
  markDisposed(paneId); // #Theme-F: 送信中だった fire() の catch に「もう蘇生するな」を伝える
  queues.update((m) => qClearPane(m, paneId));
}
