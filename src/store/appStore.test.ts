import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { cwd, focusedPane, setPaneCwd, clearPaneCwd, paneModelEffort, setPaneModelEffort } from "./appStore";

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
