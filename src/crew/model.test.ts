import { describe, it, expect } from "vitest";
import {
  actionForStatus,
  facingForAction,
  seatToCell,
  cellToIso,
  seatToIso,
  buildCrew,
  MAX_SEATS,
  TILE_W,
  TILE_H,
} from "./model";

describe("actionForStatus (PaneStatus → キャラの動作)", () => {
  it("5 状態それぞれに固有の動作が対応する", () => {
    expect(actionForStatus("running")).toBe("typing");
    expect(actionForStatus("waiting")).toBe("calling");
    expect(actionForStatus("attention")).toBe("urgent");
    expect(actionForStatus("done")).toBe("resting");
    expect(actionForStatus("failed")).toBe("down");
  });

  it("バッジ無し(null/undefined)は idle", () => {
    expect(actionForStatus(null)).toBe("idle");
    expect(actionForStatus(undefined)).toBe("idle");
  });
});

describe("facingForAction (手が要る時だけこちらを向く)", () => {
  it("calling/urgent/down は front", () => {
    expect(facingForAction("calling")).toBe("front");
    expect(facingForAction("urgent")).toBe("front");
    expect(facingForAction("down")).toBe("front");
  });

  it("typing/resting/idle はデスク側(back)を向いて作業している", () => {
    expect(facingForAction("typing")).toBe("back");
    expect(facingForAction("resting")).toBe("back");
    expect(facingForAction("idle")).toBe("back");
  });
});

describe("席の格子とアイソメ座標", () => {
  it("席は 4 列 × 2 行に左上から詰める", () => {
    expect(seatToCell(0)).toEqual({ col: 0, row: 0 });
    expect(seatToCell(3)).toEqual({ col: 3, row: 0 });
    expect(seatToCell(4)).toEqual({ col: 0, row: 1 });
    expect(seatToCell(7)).toEqual({ col: 3, row: 1 });
  });

  it("格子 → アイソメ変換は x=(col-row)*W/2, y=(col+row)*H/2", () => {
    expect(cellToIso({ col: 0, row: 0 })).toEqual({ x: 0, y: 0 });
    expect(cellToIso({ col: 1, row: 0 })).toEqual({ x: TILE_W / 2, y: TILE_H / 2 });
    expect(cellToIso({ col: 0, row: 1 })).toEqual({ x: -TILE_W / 2, y: TILE_H / 2 });
  });

  it("奥の行ほど y が小さい＝描画順(席番号順)がそのまま重なり順になる", () => {
    // 同じ列なら row が増えるほど手前(y 大)。{#each} を席順に回すだけで
    // 手前のキャラが後に描かれる＝正しい前後関係になる。
    expect(seatToIso(0).y).toBeLessThan(seatToIso(4).y);
    expect(seatToIso(3).y).toBeLessThan(seatToIso(7).y);
  });
});

describe("buildCrew (ペイン一覧 → キャラ配列)", () => {
  const info = new Map([
    [11, { role: "ai" as const, label: "orb" }],
    [12, { role: "shell" as const }],
  ]);

  it("leafIds の順がそのまま席 0.. に写る", () => {
    const crew = buildCrew([11, 12], info, new Map());
    expect(crew.map((c) => c.paneId)).toEqual([11, 12]);
    expect(crew.map((c) => c.seat)).toEqual([0, 1]);
  });

  it("状態が動作と向きに反映される", () => {
    const crew = buildCrew([11, 12], info, new Map([[11, "attention" as const]]));
    expect(crew[0].action).toBe("urgent");
    expect(crew[0].facing).toBe("front");
    expect(crew[1].action).toBe("idle");
    expect(crew[1].facing).toBe("back");
  });

  it("label が無いペインは 'pane N' にフォールバックする", () => {
    const crew = buildCrew([12], info, new Map());
    expect(crew[0].label).toBe("pane 12");
  });

  it("先頭のペインが閉じると後続の席が 1 つずつ詰む", () => {
    const before = buildCrew([11, 12, 13], info, new Map());
    const after = buildCrew([12, 13], info, new Map());
    expect(before.find((c) => c.paneId === 13)?.seat).toBe(2);
    expect(after.find((c) => c.paneId === 13)?.seat).toBe(1);
  });

  it("8 席を超えた分は捨てる（超過分の状態は TabBar バッジ/INBOX が担う）", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const crew = buildCrew(ids, new Map(), new Map());
    expect(crew).toHaveLength(MAX_SEATS);
    expect(crew.at(-1)?.paneId).toBe(MAX_SEATS);
  });

  it("ペインが 0 個（info タブ = layout:null）でも空配列を返す", () => {
    expect(buildCrew([], new Map(), new Map())).toEqual([]);
  });
});
