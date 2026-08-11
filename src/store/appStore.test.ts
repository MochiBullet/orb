import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  cwd,
  focusedPane,
  setPaneCwd,
  clearPaneCwd,
  paneModelEffort,
  setPaneModelEffort,
  paneStatus,
  paneStatusSince,
  setPaneStatus,
  broadcastTargets,
  registerPaneInput,
  unregisterPaneInput,
  sendInputToPane,
  registerPaneAltScreen,
  unregisterPaneAltScreen,
  isPaneInAltScreen,
} from "./appStore";

describe("cwd レジストリ (#45: タブ切替でサイドバーの cwd が旧ペインのまま残らない)", () => {
  it("非フォーカスペインへの setPaneCwd はグローバル cwd を変えず、フォーカス切替で反映される", () => {
    focusedPane.set(101);
    setPaneCwd(101, "C:\\work\\tab-a");
    expect(get(cwd)).toBe("C:\\work\\tab-a");

    // 別ペイン（非フォーカス）の OSC Cwd はレジストリに溜まるだけ
    setPaneCwd(102, "C:\\work\\tab-b");
    expect(get(cwd)).toBe("C:\\work\\tab-a");

    // タブ切替（loadTab → focusedPane.set）相当。OSC の再送を待たずに追従する
    focusedPane.set(102);
    expect(get(cwd)).toBe("C:\\work\\tab-b");

    // 戻っても旧値が正しく復元される
    focusedPane.set(101);
    expect(get(cwd)).toBe("C:\\work\\tab-a");
  });

  it("フォーカス中ペインへの setPaneCwd は即グローバル cwd へ反映される", () => {
    focusedPane.set(103);
    setPaneCwd(103, "C:\\repo\\orb");
    expect(get(cwd)).toBe("C:\\repo\\orb");
  });

  it("cwd 未知のペインへフォーカスすると空文字になる（嘘の残置値を出さない）", () => {
    focusedPane.set(104);
    setPaneCwd(104, "C:\\somewhere");
    focusedPane.set(999); // 一度も OSC Cwd が来ていないペイン
    expect(get(cwd)).toBe("");
  });

  it("clearPaneCwd で破棄ペインの値が消え、再フォーカスしても復活しない", () => {
    focusedPane.set(105);
    setPaneCwd(105, "C:\\dead\\pane");
    expect(get(cwd)).toBe("C:\\dead\\pane");

    focusedPane.set(106);
    clearPaneCwd(105); // Terminal.svelte onDestroy 相当
    focusedPane.set(105);
    expect(get(cwd)).toBe("");
  });
});

describe("paneModelEffort（案件ランチャーの一括起動でペインごとに model/effort を上書き表示）", () => {
  it("model のみ設定すると effort キーは持たない（フォールバックの余地を残す）", () => {
    setPaneModelEffort(201, { model: "opus" });
    expect(get(paneModelEffort).get(201)).toEqual({ model: "opus" });
  });

  it("model と effort を別々に設定すると両方がマージされる（後の呼び出しで前の値を消さない）", () => {
    setPaneModelEffort(202, { model: "sonnet" });
    setPaneModelEffort(202, { effort: "xhigh" });
    expect(get(paneModelEffort).get(202)).toEqual({ model: "sonnet", effort: "xhigh" });
  });

  it("null を渡すとそのフィールドだけ解除され、他方は残る", () => {
    setPaneModelEffort(203, { model: "opus", effort: "high" });
    setPaneModelEffort(203, { model: null });
    expect(get(paneModelEffort).get(203)).toEqual({ effort: "high" });
  });

  it("両フィールドが無くなるとエントリ自体が消える（config 由来へのフォールバックが効く）", () => {
    setPaneModelEffort(204, { model: "opus" });
    setPaneModelEffort(204, { model: null });
    expect(get(paneModelEffort).has(204)).toBe(false);
  });

  it("一度も設定していないペインは undefined（未知＝上書き無し）", () => {
    expect(get(paneModelEffort).get(9999)).toBeUndefined();
  });
});

describe("broadcastTargets (#77 FN-2/FN-4b: ブロードキャスト配送先の絞り込み)", () => {
  it("alt-screen 中でない相手は全員が対象", () => {
    expect(broadcastTargets([1, 2, 3], 1, () => false)).toEqual([1, 2, 3]);
  });

  it("alt-screen 中の他ペインは配送対象から除外される（vim/lazygit バッファ破壊防止）", () => {
    const alt = new Set([2]);
    expect(broadcastTargets([1, 2, 3], 1, (id) => alt.has(id))).toEqual([1, 3]);
  });

  it("発信元自身は alt-screen 中でも除外されない（自分の入力は落とさない）", () => {
    const alt = new Set([1]);
    expect(broadcastTargets([1, 2, 3], 1, (id) => alt.has(id))).toEqual([1, 2, 3]);
  });

  it("全員 alt-screen 中でも発信元だけは残る", () => {
    expect(broadcastTargets([1, 2, 3], 2, () => true)).toEqual([2]);
  });
});

describe("paneStatusSince", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("状態が変わった時だけ時刻を更新する", () => {
    setPaneStatus(1, null);
    setPaneStatus(1, "running");
    const first = get(paneStatusSince).get(1);
    expect(first).toBeTypeOf("number");

    setPaneStatus(1, "running"); // 同じ値の再設定
    expect(get(paneStatusSince).get(1)).toBe(first);

    vi.advanceTimersByTime(100); // 時間を進める
    setPaneStatus(1, "failed");
    expect(get(paneStatusSince).get(1)).not.toBe(first);
  });

  it("状態が消えたら時刻も消す", () => {
    setPaneStatus(2, "attention");
    expect(get(paneStatusSince).has(2)).toBe(true);
    setPaneStatus(2, null);
    expect(get(paneStatusSince).has(2)).toBe(false);
    expect(get(paneStatus).has(2)).toBe(false);
  });
});

describe("sendInputToPane / paneInputRegistry (#77 FN-2: broadcast は per-pane 入力経路を通す)", () => {
  it("登録済みペインへ isBroadcastRelay=true 付きで届く（受け側が再 broadcast しない印）", () => {
    const received: Array<{ bytes: Uint8Array; relay?: boolean }> = [];
    registerPaneInput(301, (bytes, relay) => received.push({ bytes, relay }));
    try {
      const ok = sendInputToPane(301, new Uint8Array([1, 2, 3]));
      expect(ok).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0].relay).toBe(true);
      expect(Array.from(received[0].bytes)).toEqual([1, 2, 3]);
    } finally {
      unregisterPaneInput(301);
    }
  });

  it("未登録ペイン（Terminal 未 mount）へは false を返す（呼び出し側がログを出せる＝黙ってロストしない）", () => {
    expect(sendInputToPane(99999, new Uint8Array([1]))).toBe(false);
  });
});

describe("isPaneInAltScreen (#77 FN-4b)", () => {
  it("registerPaneAltScreen で登録した判定関数の戻り値を返す", () => {
    registerPaneAltScreen(302, () => true);
    try {
      expect(isPaneInAltScreen(302)).toBe(true);
    } finally {
      unregisterPaneAltScreen(302);
    }
  });

  it("未登録ペインは false 扱い（分からない時は配送を止めない）", () => {
    expect(isPaneInAltScreen(88888)).toBe(false);
  });
});
