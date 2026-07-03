import { describe, it, expect } from "vitest";
import { tabKind, findInfoTab } from "./tabs-logic";

describe("tabKind (#47: kind 未指定の既定)", () => {
  it("kind 未定義（kind を付けない通常生成）は term 扱い", () => {
    expect(tabKind({ id: 1 })).toBe("term");
    expect(tabKind({ id: 1, kind: undefined })).toBe("term");
  });

  it("kind 明示はそのまま", () => {
    expect(tabKind({ id: 1, kind: "term" })).toBe("term");
    expect(tabKind({ id: 1, kind: "info" })).toBe("info");
  });
});

describe("findInfoTab (#47: info タブの重複作成防止)", () => {
  it("kind 混在から info タブを見つける（undefined は term として素通り）", () => {
    const info = { id: 3, kind: "info" as const };
    const found = findInfoTab([{ id: 1 }, { id: 2, kind: "term" as const }, info]);
    expect(found).toBe(info);
  });

  it("info タブが無ければ undefined", () => {
    expect(findInfoTab([{ id: 1 }, { id: 2, kind: "term" as const }])).toBeUndefined();
    expect(findInfoTab([])).toBeUndefined();
  });
});

// shouldAppendInfoTab（セッション復元起動での info 補充）は #48 のタブ構造復元廃止で
// 呼び出し元ごと消滅したため、関数・テストとも削除した。
