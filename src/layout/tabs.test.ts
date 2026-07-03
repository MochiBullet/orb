import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { tabs, activeTabId, ensureFirstTab } from "./tabs";
import { tabKind } from "./tabs-logic";
import { focusedPane, aiPane } from "../store/appStore";
import { config } from "../core/config";

/** node 環境（vitest 既定）には localStorage が無いのでスタブする。
 *  返り値の Map を覗けば「旧 SESSION_KEY が削除されたか」を検証できる。 */
function stubLocalStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

describe("ensureFirstTab (#48: タブ構造は復元せず常に fresh 構成)", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = stubLocalStorage();
    tabs.set([]); // モジュール状態をリセット（ensureFirstTab は非空なら何もしない）
    config.update((c) => ({ ...c, show_info_on_startup: true }));
  });

  it("旧 SESSION_KEY(orb.session) が残っていても無視され、削除される", () => {
    // 旧バージョンが保存したタブ構造（殻タブになるやつ）を仕込む
    store.set(
      "orb.session",
      JSON.stringify({
        tabs: [{ id: 10, layout: { kind: "leaf", paneId: 11 }, focused: 11, ai: null, name: "old" }],
        active: 10,
        counter: 57,
      }),
    );

    ensureFirstTab();

    const ts = get(tabs);
    // 復元されず fresh 構成（旧タブ名 "old" はどこにも現れない）
    expect(ts.map((t) => t.name)).toEqual(["AI", "shell", "info"]);
    // 掃除済み＝古いデータを残さない
    expect(store.has("orb.session")).toBe(false);
  });

  it("flag ON: AI + shell + info の3枚で、info がアクティブ", () => {
    ensureFirstTab();

    const ts = get(tabs);
    expect(ts).toHaveLength(3);

    const [ai, shell, info] = ts;
    expect(ai.name).toBe("AI");
    expect(tabKind(ai)).toBe("term");
    expect(ai.layout?.kind).toBe("leaf");
    expect(ai.ai).toBe(ai.focused); // AI ペイン予約済み（起動直後から model/effort が使える）

    expect(shell.name).toBe("shell");
    expect(tabKind(shell)).toBe("term");
    expect(shell.ai).toBeNull();

    expect(info.name).toBe("info");
    expect(tabKind(info)).toBe("info");
    expect(info.layout).toBeNull(); // PTY を持たない

    // info がアクティブ＝loadTab(info) 済み（focused はダミー -1）
    expect(get(activeTabId)).toBe(info.id);
    expect(get(focusedPane)).toBe(-1);
    expect(get(aiPane)).toBeNull();
  });

  it("flag OFF: AI + shell の2枚で、AI タブがアクティブ", () => {
    config.update((c) => ({ ...c, show_info_on_startup: false }));

    ensureFirstTab();

    const ts = get(tabs);
    expect(ts).toHaveLength(2);
    expect(ts.map((t) => t.name)).toEqual(["AI", "shell"]);
    expect(get(activeTabId)).toBe(ts[0].id);
    expect(get(focusedPane)).toBe(ts[0].focused);
    expect(get(aiPane)).toBe(ts[0].ai); // AI ペインがグローバルへロード済み
  });

  it("タブが既にあれば何もしない（再マウント対策）", () => {
    ensureFirstTab();
    const before = get(tabs);
    ensureFirstTab();
    expect(get(tabs)).toBe(before);
  });
});
