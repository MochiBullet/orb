import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { setPaneStatus, broadcast } from "./appStore";
import {
  qEnqueue,
  qEnqueueFront,
  qDequeue,
  qRemove,
  qUpdate,
  qMove,
  qClearPane,
  qSetPaused,
  queues,
  armedPanes,
  enqueuePrompt,
  removePrompt,
  movePrompt,
  cancelArmed,
  resumePane,
  disposePaneQueue,
  __setSendForTest,
  GRACE_MS,
  type QueueMap,
  type QueueItem,
} from "./promptQueue";

// ============================== 純関数層 ==============================

function item(paneId: number, id: string, text = "t"): QueueItem {
  return { id, paneId, text };
}

describe("プロンプトキュー純関数 (#51)", () => {
  it("qEnqueue: 末尾追加・エントリ新規作成（paused=false）", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "a"));
    m = qEnqueue(m, item(1, "b"));
    const q = m.get(1)!;
    expect(q.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(q.paused).toBe(false);
  });

  it("qEnqueueFront: 先頭へ戻す（送信失敗の復元）・paused を保つ", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "b"));
    m = qSetPaused(m, 1, true);
    m = qEnqueueFront(m, item(1, "a"));
    const q = m.get(1)!;
    expect(q.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(q.paused).toBe(true);
  });

  it("qDequeue: 先頭を取り出し、空になったらエントリごと消す", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "a"));
    m = qEnqueue(m, item(1, "b"));
    const r1 = qDequeue(m, 1);
    expect(r1.item?.id).toBe("a");
    const r2 = qDequeue(r1.map, 1);
    expect(r2.item?.id).toBe("b");
    expect(r2.map.has(1)).toBe(false); // 空エントリは残さない
    const r3 = qDequeue(r2.map, 1);
    expect(r3.item).toBeUndefined();
    expect(r3.map).toBe(r2.map); // 空なら不変
  });

  it("qRemove: id で削除・最後の1件を消すとエントリも消える・不在 id は不変", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "a"));
    m = qEnqueue(m, item(1, "b"));
    m = qRemove(m, "a");
    expect(m.get(1)!.items.map((i) => i.id)).toEqual(["b"]);
    const same = qRemove(m, "zzz");
    expect(same).toBe(m);
    m = qRemove(m, "b");
    expect(m.has(1)).toBe(false);
  });

  it("qUpdate: テキスト書き換え・不在 id は不変", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "a", "old"));
    m = qUpdate(m, "a", "new");
    expect(m.get(1)!.items[0].text).toBe("new");
    expect(qUpdate(m, "zzz", "x")).toBe(m);
  });

  it("qMove: 上下入替・端では止まる", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "a"));
    m = qEnqueue(m, item(1, "b"));
    m = qEnqueue(m, item(1, "c"));
    m = qMove(m, "c", -1);
    expect(m.get(1)!.items.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect(qMove(m, "a", -1)).toBe(m); // 先頭をさらに上へ → 不変
    expect(qMove(m, "b", 1)).toBe(m); // 末尾をさらに下へ → 不変
  });

  it("qClearPane: ペイン丸ごと破棄・他ペインは無傷", () => {
    let m: QueueMap = new Map();
    m = qEnqueue(m, item(1, "a"));
    m = qEnqueue(m, item(2, "b"));
    m = qClearPane(m, 1);
    expect(m.has(1)).toBe(false);
    expect(m.get(2)!.items.length).toBe(1);
  });

  it("qSetPaused: paused 遷移・空エントリには作用しない・同値なら不変", () => {
    let m: QueueMap = new Map();
    expect(qSetPaused(m, 1, true)).toBe(m); // エントリ無し → 不変
    m = qEnqueue(m, item(1, "a"));
    const paused = qSetPaused(m, 1, true);
    expect(paused.get(1)!.paused).toBe(true);
    expect(qSetPaused(paused, 1, true)).toBe(paused); // 同値 → 不変
    expect(qSetPaused(paused, 1, false).get(1)!.paused).toBe(false);
  });
});

// ============================== 自動送信エンジン ==============================

// テスト間で干渉しないよう paneId はテストごとにユニークにする（モジュール状態は共有）。
let paneSeq = 9000;

describe("自動送信エンジン (#51: waiting→armed→送信 / ガード網)", () => {
  let sent: Array<{ paneId: number; text: string }>;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    __setSendForTest(async (paneId, text) => {
      sent.push({ paneId, text });
    });
  });

  afterEach(() => {
    broadcast.set(false);
    vi.useRealTimers();
  });

  it("waiting になったら予約→猶予満了で送信して dequeue", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "next task");
    expect(get(armedPanes).has(p)).toBe(false); // status 不明では予約しない
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).get(p)?.itemId).toBeTruthy();
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "next task" }]);
    expect(get(queues).has(p)).toBe(false); // dequeue 済み（空エントリは消える）
    expect(get(armedPanes).has(p)).toBe(false);
    setPaneStatus(p, null);
  });

  it("attention（要承認）では絶対に予約しない", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "attention");
    expect(get(armedPanes).has(p)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    disposePaneQueue(p);
    setPaneStatus(p, null);
  });

  it("猶予中に attention へ変わったら予約解除（アイテムはキューに残す）", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).has(p)).toBe(true);
    setPaneStatus(p, "attention"); // 許可プロンプトが出た
    expect(get(armedPanes).has(p)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    expect(get(queues).get(p)?.items.length).toBe(1); // 残っている
    disposePaneQueue(p);
    setPaneStatus(p, null);
  });

  it("猶予中に running へ変わったら予約解除", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    setPaneStatus(p, "running");
    expect(get(armedPanes).has(p)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    expect(get(queues).get(p)?.items.length).toBe(1);
    disposePaneQueue(p);
    setPaneStatus(p, null);
  });

  it("failed でキューを一時停止・waiting でも送らない・再開で復帰", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "failed");
    expect(get(queues).get(p)?.paused).toBe(true);
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).has(p)).toBe(false); // paused 中は予約しない
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    resumePane(p); // UI の再開ボタン
    expect(get(armedPanes).has(p)).toBe(true);
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "x" }]);
    setPaneStatus(p, null);
  });

  it("送信直後は status が動くまで次弾を予約しない（連射防止）→ 再 waiting で次弾", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "one");
    enqueuePrompt(p, "two");
    setPaneStatus(p, "waiting");
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "one" }]);
    // status は waiting のまま＝claude が沈黙していても "two" を即予約しない
    expect(get(armedPanes).has(p)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 3);
    expect(sent.length).toBe(1);
    // 出力再開(running)→再び waiting で次弾が予約される
    setPaneStatus(p, "running");
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).has(p)).toBe(true);
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([
      { paneId: p, text: "one" },
      { paneId: p, text: "two" },
    ]);
    setPaneStatus(p, null);
  });

  it("broadcast 中は予約せず、armed 中の ON で予約解除、OFF で再評価", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).has(p)).toBe(true);
    broadcast.set(true); // 多重複製事故防止
    expect(get(armedPanes).has(p)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    broadcast.set(false); // OFF でまだ waiting なら再予約
    expect(get(armedPanes).has(p)).toBe(true);
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "x" }]);
    setPaneStatus(p, null);
  });

  it("キャンセルで予約解除・アイテムは残る・次の status 変化まで再予約しない", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    cancelArmed(p);
    expect(get(armedPanes).has(p)).toBe(false);
    expect(get(queues).get(p)?.items.length).toBe(1);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    // waiting のまま追加しても抑止中は予約しない
    enqueuePrompt(p, "y");
    expect(get(armedPanes).has(p)).toBe(false);
    // status が動いて再び waiting → 予約再開
    setPaneStatus(p, "running");
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).has(p)).toBe(true);
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "x" }]);
    disposePaneQueue(p);
    setPaneStatus(p, null);
  });

  it("先頭アイテムの削除で予約が張り直される（旧予約では発火しない）", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "first");
    enqueuePrompt(p, "second");
    setPaneStatus(p, "waiting");
    const before = get(armedPanes).get(p)!;
    vi.advanceTimersByTime(GRACE_MS / 2);
    removePrompt(p, before.itemId); // 猶予中に先頭を削除
    const after = get(armedPanes).get(p);
    expect(after?.itemId).not.toBe(before.itemId); // 新先頭で予約し直し
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "second" }]); // 二重送信しない
    setPaneStatus(p, null);
  });

  it("並び替えで先頭が変わったら予約を張り直す", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "a");
    enqueuePrompt(p, "b");
    setPaneStatus(p, "waiting");
    const items = get(queues).get(p)!.items;
    movePrompt(p, items[1].id, -1); // b を先頭へ
    expect(get(armedPanes).get(p)?.itemId).toBe(items[1].id);
    vi.advanceTimersByTime(GRACE_MS);
    expect(sent).toEqual([{ paneId: p, text: "b" }]);
    disposePaneQueue(p);
    setPaneStatus(p, null);
  });

  it("ペイン破棄でキュー・予約とも消え、発火しない", () => {
    const p = ++paneSeq;
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    expect(get(armedPanes).has(p)).toBe(true);
    disposePaneQueue(p); // Terminal.svelte onDestroy 相当
    expect(get(queues).has(p)).toBe(false);
    expect(get(armedPanes).has(p)).toBe(false);
    vi.advanceTimersByTime(GRACE_MS * 2);
    expect(sent).toEqual([]);
    setPaneStatus(p, null);
  });

  it("送信失敗はアイテムを先頭へ戻して一時停止（黙って消さない・二重送信しない）", async () => {
    const p = ++paneSeq;
    __setSendForTest(async () => {
      throw new Error("pty write failed");
    });
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    const q = get(queues).get(p);
    expect(q?.items.map((i) => i.text)).toEqual(["x"]); // 先頭へ復元
    expect(q?.paused).toBe(true);
    disposePaneQueue(p);
    setPaneStatus(p, null);
  });

  it("#Theme-F: 送信中にペイン破棄→送信失敗でも蘇生しない（死んだペインの幽霊キューを作らない）", async () => {
    const p = ++paneSeq;
    let rejectSend!: (e: unknown) => void;
    __setSendForTest(() => new Promise((_, rej) => { rejectSend = rej; }));
    enqueuePrompt(p, "x");
    setPaneStatus(p, "waiting");
    await vi.advanceTimersByTimeAsync(GRACE_MS); // fire()→送信開始（dequeue 済み・送信は保留）
    expect(get(queues).has(p)).toBe(false); // 送信中はキュー空
    disposePaneQueue(p); // 送信中にペイン破棄（Terminal.svelte onDestroy 相当）
    rejectSend(new Error("pty write failed")); // その後に送信が失敗
    await Promise.resolve();
    await Promise.resolve();
    expect(get(queues).has(p)).toBe(false); // 蘇生しない＝幽霊キューを作らない
    setPaneStatus(p, null);
  });
});
