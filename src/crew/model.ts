/**
 * Crew ビュー（ペイン＝キャラ）の純ロジック。DOM/Svelte/Tauri 非依存＝vitest 対象。
 *
 * 状態判定そのものは一切持たない。agent-status.ts が PTY 出力から決めた PaneStatus を
 * 「見た目」へ写すだけ（判定を二重実装するとバッジ・通知・キャラの表示がズレるため、
 * agent-status.ts 冒頭のコメントと同じ方針で単一の真実に乗る）。
 */
import type { PaneStatus } from "../core/agent-status";
import type { PaneRole } from "../layout/tree";

/** キャラの動作。PaneStatus と 1:1 で対応する（+ バッジ無しの idle）。 */
export type CrewAction = "typing" | "calling" | "urgent" | "resting" | "down" | "idle";

/** キャラの向き。奥(デスク側)を向いていれば作業中、こちらを向いていれば人間の手が要る。 */
export type CrewFacing = "back" | "front";

export const SEAT_COLS = 4;
export const SEAT_ROWS = 2;
export const MAX_SEATS = SEAT_COLS * SEAT_ROWS;

/** アイソメ 1 タイルの見かけの大きさ(px)。菱形なので 幅:高さ = 2:1。 */
export const TILE_W = 96;
export const TILE_H = 48;

export interface CrewMember {
  paneId: number;
  /** 0..MAX_SEATS-1。席番号がそのままアイソメ座標に写る。 */
  seat: number;
  /** ホバー時に出す名前。案件ランチャー由来の label、無ければ "pane N"。 */
  label: string;
  role: PaneRole;
  status: PaneStatus | null;
  action: CrewAction;
  facing: CrewFacing;
}

export function actionForStatus(s: PaneStatus | null | undefined): CrewAction {
  switch (s) {
    case "running":
      return "typing";
    case "waiting":
      return "calling";
    case "attention":
      return "urgent";
    case "done":
      return "resting";
    case "failed":
      return "down";
    default:
      return "idle";
  }
}

/**
 * 「人間の手が要る状態だけこちらを向く」という一本のルールで向きを決める。
 * 作業中(typing)・完了直後(resting)・待機(idle) はデスク側を向いたまま＝放っておいてよい。
 */
export function facingForAction(a: CrewAction): CrewFacing {
  return a === "calling" || a === "urgent" || a === "down" ? "front" : "back";
}

/** 席番号 → 格子座標。左上から横に詰める（4 列で折り返す）。 */
export function seatToCell(seat: number): { col: number; row: number } {
  return { col: seat % SEAT_COLS, row: Math.floor(seat / SEAT_COLS) };
}

/**
 * 格子座標 → アイソメの画面オフセット(px)。2D アイソメの標準変換。
 * 原点(0,0)は格子の (0,0) タイル中心で、実際の中央寄せは描画側が行う。
 */
export function cellToIso(cell: { col: number; row: number }): { x: number; y: number } {
  return {
    x: (cell.col - cell.row) * (TILE_W / 2),
    y: (cell.col + cell.row) * (TILE_H / 2),
  };
}

export function seatToIso(seat: number): { x: number; y: number } {
  return cellToIso(seatToCell(seat));
}

/**
 * ペイン一覧（leafIds の順）＋付帯情報＋状態から、描画すべきキャラ配列を作る。
 * paneIds の順序はペイン木の左→右/上→下で安定しているので、そのまま席順にできる。
 */
export function buildCrew(
  paneIds: number[],
  info: Map<number, { role?: PaneRole; label?: string }>,
  status: ReadonlyMap<number, PaneStatus>,
): CrewMember[] {
  return paneIds.slice(0, MAX_SEATS).map((paneId, seat) => {
    const i = info.get(paneId);
    const s = status.get(paneId) ?? null;
    const action = actionForStatus(s);
    return {
      paneId,
      seat,
      label: i?.label || `pane ${paneId}`,
      role: i?.role ?? "shell",
      status: s,
      action,
      facing: facingForAction(action),
    };
  });
}
