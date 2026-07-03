import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { cwd, focusedPane, setPaneCwd, clearPaneCwd } from "./appStore";

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
