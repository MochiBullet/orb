import { describe, it, expect } from "vitest";
import { tabKind, findInfoTab, shouldAppendInfoTab } from "./tabs-logic";

describe("tabKind (#47: kind の後方互換)", () => {
  it("kind 未定義（#47 導入前の保存済みセッション）は term 扱い", () => {
    expect(tabKind({ id: 1 })).toBe("term");
    expect(tabKind({ id: 1, kind: undefined })).toBe("term");
  });

  it("kind 明示はそのまま", () => {
    expect(tabKind({ id: 1, kind: "term" })).toBe("term");
    expect(tabKind({ id: 1, kind: "info" })).toBe("info");
  });
});

describe("findInfoTab (#47: info タブの重複作成防止)", () => {
  it("kind 混在から info タブを見つける（旧形式 undefined は term として素通り）", () => {
    const info = { id: 3, kind: "info" as const };
    const found = findInfoTab([{ id: 1 }, { id: 2, kind: "term" as const }, info]);
    expect(found).toBe(info);
  });

  it("info タブが無ければ undefined", () => {
    expect(findInfoTab([{ id: 1 }, { id: 2, kind: "term" as const }])).toBeUndefined();
    expect(findInfoTab([])).toBeUndefined();
  });
});

describe("shouldAppendInfoTab (#47: セッション復元起動での末尾補充)", () => {
  const legacyTerm = { id: 1 }; // kind 導入前の保存形式
  const infoTab = { id: 2, kind: "info" as const };

  it("flag ON かつ復元セットに info が無い → 補充する", () => {
    expect(shouldAppendInfoTab([legacyTerm], true)).toBe(true);
  });

  it("flag ON でも復元セットに info が既にある → 補充しない（重複防止）", () => {
    expect(shouldAppendInfoTab([legacyTerm, infoTab], true)).toBe(false);
  });

  it("flag OFF → 補充しない", () => {
    expect(shouldAppendInfoTab([legacyTerm], false)).toBe(false);
    expect(shouldAppendInfoTab([], false)).toBe(false);
  });
});
